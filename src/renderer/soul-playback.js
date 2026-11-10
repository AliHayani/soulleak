// Soul Playback: a monthly recap of what you listened to (Wrapped / Playback style).
//
// Tracking: app.js calls tick() once per second of real playback (the same timer that feeds the ranks). Seconds
// always count; a "play" is logged once a track has been listened to for 30 s in one go, so skips don't count.
// Data lives in IndexedDB ('soulleak-playback', store 'months'), one record per month keyed 'YYYY-MM':
//   { month, totalSeconds, tracks: { [id]: { id, title, artist, artwork, sourceUrl, platform, playCount,
//     secondsListened, track } }, artists: { [name]: { name, artwork, playCount, secondsListened } } }
// One record per month keeps a yearly recap a simple sum over twelve records.
//
// The page is rendered into #slpb-root when the Soul Playback view opens. app.js hands this module an adapter via
// attach() for everything it needs from the app (playing, playlists, artist pages, history for the backfill).
(function () {
  'use strict';

  const DB_NAME = 'soulleak-playback';
  const STORE = 'months';
  const PLAY_AFTER_S = 30;
  const FLUSH_EVERY_S = 15;
  const TOP_N = 10;
  const SINCE_KEY = 'soulleak_playback_since';
  const SEED_KEY = 'soulleak_playback_seeded_v1';

  let app = null;
  let db = null;
  let loaded = false;
  const months = new Map();
  const dirty = new Set();
  let session = null;
  let ticks = 0;
  let viewMonth = null;
  let menuOpen = false;

  // ---------- helpers ----------

  function monthKey(d) {
    const x = d instanceof Date ? d : new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthLabel(key, withYear = true) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1, 1);
    return d.toLocaleDateString('en-US', withYear ? { month: 'long', year: 'numeric' } : { month: 'long' });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // "2 h 05 min", "34 min", "45 s"
  function fmtTime(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
    if (m) return `${m} min`;
    return `${s} s`;
  }

  function fmtPlays(n) { return `${n} ${n === 1 ? 'play' : 'plays'}`; }

  function emptyBucket(month) {
    return { month, totalSeconds: 0, tracks: {}, artists: {} };
  }

  function bucket(month) {
    let b = months.get(month);
    if (!b) { b = emptyBucket(month); months.set(month, b); }
    return b;
  }

  // Only plain fields go into the saved copy of a track, so it can be played again later.
  function snapshot(t) {
    const out = {};
    if (!t) return out;
    for (const k of Object.keys(t)) {
      if (k.startsWith('_') || k === 'playedAt') continue;
      const v = t[k];
      if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        if (typeof v === 'string' && v.length > 2048) continue;
        out[k] = v;
      }
    }
    return out;
  }

  function describe(track) {
    const d = app.describe(track);
    if (!d || !d.id) return null;
    d.snapshot = snapshot(track);
    return d;
  }

  // ---------- storage ----------

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'month' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function flush() {
    // Mid account switch (accounts.js): the database already holds the next account.
    if (window.__slSwitching) return;
    if (!db || !dirty.size) return;
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      dirty.forEach((m) => { const b = months.get(m); if (b) store.put(b); });
      dirty.clear();
    } catch (e) {
      console.warn('[Soul Playback] save failed', e);
    }
  }

  // Adds `add` into `into` (used to merge seconds counted before the database finished opening).
  function mergeBucket(into, add) {
    into.totalSeconds += add.totalSeconds || 0;
    for (const [k, t] of Object.entries(add.tracks || {})) {
      const cur = into.tracks[k];
      if (!cur) { into.tracks[k] = t; continue; }
      cur.playCount += t.playCount || 0;
      cur.secondsListened += t.secondsListened || 0;
    }
    for (const [k, a] of Object.entries(add.artists || {})) {
      const cur = into.artists[k];
      if (!cur) { into.artists[k] = a; continue; }
      cur.playCount += a.playCount || 0;
      cur.secondsListened += a.secondsListened || 0;
    }
  }

  async function load() {
    try {
      db = await openDb();
      const rows = await new Promise((resolve, reject) => {
        const req = db.transaction(STORE).objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      const early = new Map(months);
      months.clear();
      rows.forEach((r) => { if (r && r.month) months.set(r.month, Object.assign(emptyBucket(r.month), r)); });
      early.forEach((b, m) => { mergeBucket(bucket(m), b); dirty.add(m); });
    } catch (e) {
      console.warn('[Soul Playback] IndexedDB unavailable', e);
    }
    loaded = true;
  }

  // ---------- tracking ----------

  function tick(track, position) {
    if (!app || !track) return;
    // Song details are looked up once per listen, not every second.
    const desc = (session && session.ref === track && session.desc) || describe(track);
    if (!desc || !desc.id) return;
    const pos = Number.isFinite(position) ? position : 0;
    // A new listen: another song, or the same one started over (repeat, or played again from the top).
    if (!session || session.id !== desc.id || (pos + 3 < session.lastPos && pos < 5 && session.seconds >= PLAY_AFTER_S)) {
      // Save the listen that just ended (between songs; otherwise every FLUSH_EVERY_S seconds and on close).
      if (session) flush();
      session = { id: desc.id, seconds: 0, counted: false, lastPos: pos };
    }
    session.ref = track;
    session.desc = desc;
    session.lastPos = pos;
    session.seconds += 1;

    const month = monthKey(new Date());
    const b = bucket(month);
    b.totalSeconds += 1;

    let te = b.tracks[desc.id];
    if (!te) {
      te = b.tracks[desc.id] = { id: desc.id, title: desc.title, artist: desc.artist, artwork: desc.artwork, sourceUrl: desc.sourceUrl, platform: desc.platform, playCount: 0, secondsListened: 0, track: desc.snapshot };
    } else {
      // Keep the latest title / art (renames and custom covers can change them).
      te.title = desc.title || te.title;
      te.artist = desc.artist || te.artist;
      if (desc.artwork) te.artwork = desc.artwork;
    }
    te.secondsListened += 1;

    let ae = null;
    if (desc.artistKey) {
      ae = b.artists[desc.artistKey];
      if (!ae) ae = b.artists[desc.artistKey] = { name: desc.primaryArtist, artwork: desc.artwork || '', playCount: 0, secondsListened: 0 };
      ae.secondsListened += 1;
      if (!ae.artwork && desc.artwork) ae.artwork = desc.artwork;
    }

    if (!session.counted && session.seconds >= PLAY_AFTER_S) {
      session.counted = true;
      te.playCount += 1;
      if (te.playCount === 1 || !te.track || !te.track.id) te.track = desc.snapshot;
      if (ae) ae.playCount += 1;
    }

    dirty.add(month);
    ticks += 1;
    if (ticks % FLUSH_EVERY_S === 0) {
      flush();
      if (isOpen() && viewMonth === month && !menuOpen) render();
      if (homeVisible()) renderHero();
    }
  }

  // ---------- backfill from history ----------

  // History keeps each song once (its latest play). The rank counters hold the real seconds per song, so a song's
  // time comes from there and its plays are estimated from that time and the song's length.
  function seedFromHistory() {
    try {
      if (localStorage.getItem(SEED_KEY)) return;
      let since = parseInt(localStorage.getItem(SINCE_KEY) || '0', 10);
      if (!since) { since = Date.now(); localStorage.setItem(SINCE_KEY, String(since)); }
      const history = (app.history && app.history()) || [];
      let added = 0;
      history.forEach((t) => {
        if (!t || !t.playedAt || t.playedAt >= since) return;
        const desc = describe(t);
        if (!desc || !desc.id) return;
        const dur = Number(t.duration) > 0 ? Number(t.duration) : 180;
        // No counter for it (history older than the rank counters): one listen of its length, as an estimate.
        const counted = Math.round(app.songSeconds ? app.songSeconds(t) : 0);
        const seconds = counted > 0 ? counted : Math.min(dur, 600);
        const plays = seconds >= PLAY_AFTER_S ? Math.max(1, Math.round(seconds / Math.max(60, dur))) : 0;
        const month = monthKey(t.playedAt);
        const b = bucket(month);
        if (b.tracks[desc.id]) return;
        b.seeded = true;
        b.totalSeconds += seconds;
        b.tracks[desc.id] = { id: desc.id, title: desc.title, artist: desc.artist, artwork: desc.artwork, sourceUrl: desc.sourceUrl, platform: desc.platform, playCount: plays, secondsListened: seconds, track: desc.snapshot, seeded: true };
        if (desc.artistKey) {
          const ae = b.artists[desc.artistKey] || (b.artists[desc.artistKey] = { name: desc.primaryArtist, artwork: desc.artwork || '', playCount: 0, secondsListened: 0 });
          ae.playCount += plays;
          ae.secondsListened += seconds;
          if (!ae.artwork && desc.artwork) ae.artwork = desc.artwork;
        }
        dirty.add(month);
        added += 1;
      });
      localStorage.setItem(SEED_KEY, String(Date.now()));
      flush();
      if (added) console.log(`[Soul Playback] backfilled ${added} songs from history`);
    } catch (e) {
      console.warn('[Soul Playback] backfill failed', e);
    }
  }

  async function ready() {
    if (loaded) return;
    await load();
    if (!localStorage.getItem(SINCE_KEY) && !localStorage.getItem(SEED_KEY)) {
      // First run: history before this moment is the backfill, everything after is tracked live.
      localStorage.setItem(SINCE_KEY, String(Date.now()));
    }
    seedFromHistory();
    if (isOpen()) render();
    renderHero();
  }

  // ---------- ranking ----------

  function byPlays(a, b) {
    return (b.playCount - a.playCount) || (b.secondsListened - a.secondsListened);
  }

  function topTracks(b, n = TOP_N) {
    return Object.values(b.tracks).filter((t) => t.playCount > 0).sort(byPlays).slice(0, n);
  }

  function topArtists(b, n = TOP_N) {
    const list = Object.values(b.artists).filter((a) => a.playCount > 0).sort(byPlays).slice(0, n);
    return list.map((a) => {
      const avatar = app && app.artistAvatar ? app.artistAvatar(a.name) : '';
      if (avatar) return Object.assign({}, a, { artwork: avatar });
      // No artist photo cached: use the cover of their most played song this month.
      const best = Object.values(b.tracks).filter((t) => t.playCount > 0 && app && app.sameArtist(t.artist, a.name)).sort(byPlays)[0];
      return Object.assign({}, a, { artwork: (best && best.artwork) || a.artwork });
    });
  }

  function availableMonths() {
    const set = new Set([monthKey(new Date())]);
    months.forEach((b, m) => { if (b.totalSeconds > 0) set.add(m); });
    return [...set].sort().reverse();
  }

  // Heavy rotation: your most played songs, from plays and time across recent months. This month counts in full,
  // last month at 60%, older months at 30%, so it follows what you're into now. Returns playable track objects
  // with playCount / secondsListened attached.
  function heavyRotation(n = 10) {
    const cur = monthKey(new Date());
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    const prev = monthKey(d);
    const agg = new Map();
    months.forEach((b, m) => {
      const w = m === cur ? 1 : m === prev ? 0.6 : 0.3;
      Object.values(b.tracks || {}).forEach((t) => {
        if (!t || !(t.playCount > 0)) return;
        const a = agg.get(t.id) || { t, score: 0, plays: 0, secs: 0 };
        a.score += (t.playCount * 180 + t.secondsListened) * w;
        a.plays += t.playCount;
        a.secs += t.secondsListened;
        if (m === cur || !a.t.track) a.t = t;
        agg.set(t.id, a);
      });
    });
    return [...agg.values()].sort((x, y) => y.score - x.score).slice(0, n).map(({ t, plays, secs }) => {
      const base = t.track && t.track.id ? t.track : { id: t.id, title: t.title, artist: t.artist, platform: t.platform, url: t.sourceUrl, thumbnail: t.artwork };
      return Object.assign({}, base, { _slPlays: plays, _slSecs: secs, _slArt: t.artwork || '' });
    });
  }

  // Twelve monthly records summed: the base for a yearly recap later.
  function yearBucket(year) {
    const out = emptyBucket(String(year));
    months.forEach((b, m) => { if (m.startsWith(`${year}-`)) mergeBucket(out, JSON.parse(JSON.stringify(b))); });
    return out;
  }

  // ---------- UI ----------

  function root() { return document.getElementById('slpb-root'); }
  function isOpen() {
    const v = document.getElementById('view-playback');
    return !!(v && v.classList.contains('active'));
  }

  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>';
  const ICON_SAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  function art(url, cls, round) {
    const safe = typeof url === 'string' && /^(https?:|file:|data:image\/)/i.test(url) ? url : '';
    return `<span class="${cls}${round ? ' is-round' : ''}">${safe ? `<img src="${esc(safe)}" alt="" loading="lazy" draggable="false" onerror="this.remove()">` : ''}</span>`;
  }

  function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

  function render() {
    const r = root();
    if (!r || !app) return;
    const current = monthKey(new Date());
    if (!viewMonth) viewMonth = current;
    const b = months.get(viewMonth) || emptyBucket(viewMonth);
    const tracks = topTracks(b);
    const artists = topArtists(b);
    const allPlays = Object.values(b.tracks).reduce((n, t) => n + (t.playCount || 0), 0);
    const songCount = Object.values(b.tracks).filter((t) => t.playCount > 0).length;
    const artistCount = Object.values(b.artists).filter((a) => a.playCount > 0).length;
    const isCurrent = viewMonth === current;
    const list = availableMonths();
    const empty = tracks.length === 0;

    const [yy] = viewMonth.split('-');
    const monthName = monthLabel(viewMonth, false);

    // The month name is the page title, and also the month picker.
    const monthMenu = `<div class="slpb-month${menuOpen ? ' open' : ''}">
        <h1 class="slpb-title"><button type="button" class="slpb-month-btn" data-sp="month" aria-haspopup="listbox" aria-expanded="${menuOpen}" title="Pick a month">${esc(monthName)} <span class="slpb-year">${esc(yy)}</span>${ICON_CHEV}</button></h1>
        <ul class="slpb-month-menu" role="listbox">${list.map((m) => `<li role="option" aria-selected="${m === viewMonth}"><button type="button" data-sp-month="${m}" class="${m === viewMonth ? 'is-on' : ''}">${esc(monthLabel(m))}</button></li>`).join('')}</ul>
      </div>`;

    const time = `<strong>${esc(fmtTime(b.totalSeconds))}</strong>`;
    const spread = `${plural(allPlays, 'play', 'plays')}, ${plural(songCount, 'song', 'songs')} and ${plural(artistCount, 'artist', 'artists')}`;
    const lede = empty
      ? (isCurrent ? "Nothing's counted yet this month. A song counts once you've listened to it for 30 seconds." : `Nothing was counted in ${esc(monthName)}.`)
      : (isCurrent ? `So far this month you've listened for ${time}, across ${spread}.` : `In ${esc(monthName)} you listened for ${time}, across ${spread}.`);

    const actions = empty ? '' : `<div class="slpb-actions">
        <button type="button" class="slpb-btn primary" data-sp="play">${ICON_PLAY}<span>Play your top ${Math.min(TOP_N, tracks.length)}</span></button>
        <button type="button" class="slpb-btn ghost" data-sp="save">${ICON_SAVE}<span>Save as playlist</span></button>
      </div>`;

    const t1 = tracks[0];
    const a1 = artists[0];
    const feature = empty ? '' : `<section class="slpb-feature">
        <button type="button" class="slpb-feat" data-sp-track="0" title="Play ${esc(t1.title)}">
          <span class="slpb-feat-art">${art(t1.artwork, 'slpb-feat-img')}<span class="slpb-feat-play">${ICON_PLAY}</span></span>
          <span class="slpb-feat-text">
            <span class="slpb-feat-kind">Song of the month</span>
            <span class="slpb-feat-name">${esc(t1.title)}</span>
            <span class="slpb-feat-sub">${esc(t1.artist)}</span>
            <span class="slpb-feat-stat">${fmtPlays(t1.playCount)} · ${fmtTime(t1.secondsListened)}</span>
          </span>
        </button>
        ${a1 ? `<button type="button" class="slpb-feat is-artist" data-sp-artist="0" title="Open ${esc(a1.name)}">
          <span class="slpb-feat-art">${art(a1.artwork, 'slpb-feat-img', true)}</span>
          <span class="slpb-feat-text">
            <span class="slpb-feat-kind">Artist of the month</span>
            <span class="slpb-feat-name">${esc(a1.name)}</span>
            <span class="slpb-feat-stat">${fmtPlays(a1.playCount)} · ${fmtTime(a1.secondsListened)}</span>
          </span>
        </button>` : ''}
      </section>`;

    const songRows = tracks.map((t, i) => `<li>
        <button type="button" class="slpb-row" data-sp-track="${i}">
          <span class="slpb-rank">${i + 1}</span>
          <span class="slpb-row-art">${art(t.artwork, 'slpb-row-img')}<span class="slpb-row-play">${ICON_PLAY}</span></span>
          <span class="slpb-row-text"><span class="slpb-row-title">${esc(t.title)}</span><span class="slpb-row-sub">${esc(t.artist)}</span></span>
          <span class="slpb-row-stat">${fmtPlays(t.playCount)}<span>${fmtTime(t.secondsListened)}</span></span>
        </button></li>`).join('');

    const artistRows = artists.map((a, i) => `<li>
        <button type="button" class="slpb-row" data-sp-artist="${i}">
          <span class="slpb-rank">${i + 1}</span>
          <span class="slpb-row-art">${art(a.artwork, 'slpb-row-img', true)}</span>
          <span class="slpb-row-text"><span class="slpb-row-title">${esc(a.name)}</span></span>
          <span class="slpb-row-stat">${fmtPlays(a.playCount)}<span>${fmtTime(a.secondsListened)}</span></span>
        </button></li>`).join('');

    const lists = empty ? '' : `<section class="slpb-lists">
        <div class="slpb-col">
          <h2 class="slpb-h2">Top songs</h2>
          <ol class="slpb-list">${songRows}</ol>
        </div>
        <div class="slpb-col">
          <h2 class="slpb-h2">Top artists</h2>
          <ol class="slpb-list">${artistRows}</ol>
        </div>
      </section>`;

    const note = b.seeded ? '<p class="slpb-note">Some of these plays come from your history before Soul Playback started counting, so their play counts are estimates.</p>' : '';

    r.innerHTML = `<div class="slpb">
        <header class="slpb-head">
          <p class="slpb-eyebrow">Soul Playback</p>
          ${monthMenu}
          <p class="slpb-lede">${lede}</p>
          ${actions}
        </header>
        ${feature}
        ${lists}
        ${note}
      </div>`;
    r._sp = { tracks, artists, month: viewMonth };
  }

  function playFrom(index) {
    const st = root() && root()._sp;
    if (!st || !st.tracks.length) return;
    const list = st.tracks.map((t) => Object.assign({}, t.track && t.track.id ? t.track : { id: t.id, title: t.title, artist: t.artist, platform: t.platform, url: t.sourceUrl, thumbnail: t.artwork }));
    app.playList(list, Math.max(0, Math.min(index, list.length - 1)));
  }

  function saveAsPlaylist() {
    const st = root() && root()._sp;
    if (!st || !st.tracks.length) return;
    const list = st.tracks.map((t) => Object.assign({}, t.track && t.track.id ? t.track : { id: t.id, title: t.title, artist: t.artist, platform: t.platform, url: t.sourceUrl, thumbnail: t.artwork }));
    const name = `Soul Playback · ${monthLabel(st.month)}`;
    const cover = st.tracks[0] && /^https:/i.test(st.tracks[0].artwork || '') ? st.tracks[0].artwork : '';
    const res = app.savePlaylist(name, list, cover);
    if (res === 'updated') app.toast(`Updated "${name}"`, 'success');
    else if (res) app.toast(`Saved "${name}" to your playlists`, 'success');
  }

  function onClick(e) {
    const r = root();
    const monthBtn = e.target.closest('[data-sp-month]');
    if (monthBtn) {
      viewMonth = monthBtn.dataset.spMonth;
      menuOpen = false;
      render();
      return;
    }
    const act = e.target.closest('[data-sp]');
    if (act) {
      const a = act.dataset.sp;
      if (a === 'month') { menuOpen = !menuOpen; render(); return; }
      if (a === 'play') { playFrom(0); return; }
      if (a === 'save') { saveAsPlaylist(); return; }
    }
    if (menuOpen && !e.target.closest('.slpb-month')) { menuOpen = false; render(); return; }
    const tr = e.target.closest('[data-sp-track]');
    if (tr) { playFrom(Number(tr.dataset.spTrack) || 0); return; }
    const ar = e.target.closest('[data-sp-artist]');
    if (ar && r && r._sp) {
      const a = r._sp.artists[Number(ar.dataset.spArtist) || 0];
      if (a && app.openArtist) app.openArtist(a.name);
    }
  }

  function open() {
    viewMonth = monthKey(new Date());
    menuOpen = false;
    render();
  }

  function attach(adapter) {
    app = adapter;
    const wire = () => {
      const r = root();
      if (r && !r._spWired) {
        r._spWired = true;
        r.addEventListener('click', onClick);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) { menuOpen = false; render(); } });
      }
      const hero = heroRoot();
      if (hero && !hero._slWired) {
        hero._slWired = true;
        hero.addEventListener('click', onHeroClick);
        // Keep the Resume card's Play / Pause state in step with the player.
        const audio = document.getElementById('native-audio');
        if (audio) ['play', 'pause', 'loadeddata'].forEach((ev) => audio.addEventListener(ev, () => { if (homeVisible()) renderHero(); }));
        // Whenever the sidebar rank card updates (progress, rank up), the hero follows.
        const level = document.getElementById('ob-level');
        if (level) {
          let pending = null;
          new MutationObserver(() => {
            if (pending) return;
            pending = setTimeout(() => { pending = null; if (homeVisible()) renderHero(); }, 250);
          }).observe(level, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'] });
        }
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
    else wire();
    window.addEventListener('beforeunload', flush);
  }

  // ---------- Home hero: rank, this month's time, and a one-click resume ----------

  function heroRoot() { return document.getElementById('sl-hero'); }
  function homeVisible() {
    const v = document.getElementById('view-discover');
    return !!(v && v.classList.contains('active'));
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return 'Up late';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function resumeTrack() {
    const cur = app && app.current ? app.current() : null;
    if (cur) return { track: cur, isCurrent: true };
    const h = (app && app.history && app.history()) || [];
    return h.length ? { track: h[0], isCurrent: false } : null;
  }

  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>';

  function renderHero() {
    const hero = heroRoot();
    if (!hero || !app) return;
    // The hero's auras and motes hold still while the hero is off screen (another page open, or scrolled away).
    if (!hero._slSeen && window.IntersectionObserver) {
      hero._slSeen = true;
      new IntersectionObserver((en) => { hero.classList.toggle('sl-offscreen', !en[en.length - 1].isIntersecting); }).observe(hero);
    }
    // The rank comes from the sidebar card, which the rank system keeps up to date.
    const text = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : ''; };
    const fillEl = document.getElementById('ob-level-fill');
    // The sidebar bar is filled with transform: scaleX(f), not a width; turn that into a percentage.
    let pct = 0;
    if (fillEl) {
      const m = /scaleX\(\s*([\d.]+)\s*\)/.exec(fillEl.style.transform || '');
      if (m) pct = parseFloat(m[1]) * 100;
      else if (fillEl.style.width) pct = parseFloat(fillEl.style.width) || 0;
    }
    const fill = `${Math.max(0, Math.min(100, Math.round(pct * 10) / 10))}%`;
    const emblemEl = document.getElementById('ob-level-emblem');
    // The copy gets its own gradient ids: the sidebar card can be hidden (icon rail), and gradients defined
    // inside a hidden element don't paint.
    const emblem = emblemEl ? emblemEl.innerHTML.replace(/(id="|url\(#)([^")]+)/g, '$1$2-hero') : '';
    const month = months.get(monthKey(new Date()));
    const secs = month ? month.totalSeconds : 0;

    const r = resumeTrack();
    let resume = '';
    if (r) {
      const t = r.track;
      const playing = r.isCurrent && app.isPlaying && app.isPlaying();
      const cover = [t.thumbnail, t.cover].find((u) => typeof u === 'string' && /^https?:/i.test(u)) || '';
      const kind = playing ? 'Now playing' : (r.isCurrent ? 'Paused' : 'Resume last session');
      resume = `<button type="button" class="sl-resume${playing ? ' is-playing' : ''}" data-sl-hero="resume" title="${playing ? 'Pause' : 'Play'} ${esc(t.title || '')}">
          ${art(cover, 'sl-resume-art')}
          <span class="sl-resume-text">
            <span class="sl-resume-kind">${kind}</span>
            <span class="sl-resume-title">${esc(t.title || 'Untitled')}</span>
            <span class="sl-resume-sub">${esc(t.artist || '')}</span>
          </span>
          <span class="sl-resume-btn">${playing ? ICON_PAUSE : ICON_PLAY}</span>
        </button>`;
    }

    hero.innerHTML = `<div class="sl-hero-fx" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      <div class="sl-hero-main">
        <h1 class="sl-hero-title">${greeting()}</h1>
        <div class="sl-hero-stats">
          <button type="button" class="sl-hero-rank" data-sl-hero="rank" title="Open your ranks and badges">
            <span class="sl-hero-emblem" aria-hidden="true">${emblem}</span>
            <span class="sl-hero-rank-text">
              <span class="sl-hero-rank-name">${esc(text('ob-level-name') || 'Spawn')} <em>${esc(text('ob-level-tier'))}</em></span>
              <span class="sl-hero-bar"><i style="width:${esc(fill)}"></i></span>
              <span class="sl-hero-rank-sub">${esc(text('ob-level-sub'))}</span>
            </span>
          </button>
          <button type="button" class="sl-hero-month" data-sl-hero="playback" title="Open Soul Playback">
            <span class="sl-hero-big">${esc(fmtTime(secs))}</span>
            <span class="sl-hero-rank-sub">listened in ${esc(monthLabel(monthKey(new Date()), false))}</span>
          </button>
        </div>
      </div>
      ${resume}`;
    hero._slResume = r;
  }

  function onHeroClick(e) {
    const b = e.target.closest('[data-sl-hero]');
    if (!b || !app) return;
    const act = b.dataset.slHero;
    if (act === 'rank') document.getElementById('ob-level')?.click();
    else if (act === 'playback') document.getElementById('nav-playback')?.click();
    else if (act === 'resume') {
      const r = heroRoot()._slResume;
      if (!r) return;
      if (r.isCurrent) app.togglePlay();
      else app.playList([Object.assign({}, r.track)], 0);
    }
  }

  window.SoulPlayback = {
    attach,
    ready,
    tick,
    flush,
    open,
    render,
    renderHero,
    heavyRotation,
    // For a yearly recap later: monthly records and a sum over a year.
    months: () => new Map(months),
    year: yearBucket,
    // Soulleak Cloud (cloud-sync.js): all month records as plain data, and taking in another PC's months. A month
    // keeps whichever side listened more (the same listening is never counted twice).
    exportMonths: () => Array.from(months.values()).map((b) => JSON.parse(JSON.stringify(b))),
    mergeMonths: (rows) => {
      let changed = false;
      (Array.isArray(rows) ? rows : []).forEach((r) => {
        if (!r || !r.month) return;
        const cur = months.get(r.month);
        if (cur && (cur.totalSeconds || 0) >= (r.totalSeconds || 0)) return;
        months.set(r.month, Object.assign(emptyBucket(r.month), JSON.parse(JSON.stringify(r))));
        dirty.add(r.month);
        changed = true;
      });
      if (changed) flush();
      return changed;
    },
  };
})();
