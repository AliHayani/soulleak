// Soulleak Cloud: sign in, and keep playlists, liked songs, history, listening time (rank), Soul Playback and settings
// in sync across PCs through Supabase. The login itself lives in the main process (src/main/cloud.js); this file
// merges and draws the Account card.
//
// Offline-first: the app always starts from what is on this PC. Sync runs in the background: a few seconds after
// start, 5 s after a change, every 10 minutes (listening time) and when the app closes.
//
// Merging never wipes anything by accident. It is a three-way merge against the last synced copy ("base"):
//   - something new on either PC is kept; something deleted on one PC stays deleted (it doesn't come back);
//   - listening time and Soul Playback months keep the higher value, so time is never lost or counted twice;
//   - a setting keeps whichever side changed it.
// The very first sync has no base: it is a plain union (nothing is removed), so signing in on a PC that already has
// playlists merges them with the cloud. On a fresh PC (nothing local yet) the cloud library is restored as is.
(function () {
  'use strict';

  const api = () => (window.electronAPI && window.electronAPI.cloud) || null;
  const ACTIVE_KEY = 'soulleak_active_account';
  const LAST_SYNC_KEY = 'sl_cloud_last_sync';
  const DEBOUNCE_MS = 5000;
  const PERIODIC_MS = 10 * 60 * 1000; // full sync at least this often (listening time, which changes all the time)
  const CHECK_MS = 2 * 60 * 1000;      // light "did the cloud change?" check
  const FOCUS_GAP_MS = 15 * 1000;      // focus checks at most this often
  const HISTORY_MAX = 100;
  const MAX_AVATAR_CHARS = 700 * 1024;

  let app = null;
  let status = { signedIn: false };
  let syncing = false;
  let again = false;
  let timer = null;
  let lastError = '';
  let offline = false;
  let suppressSchedule = 0;

  // ---------- what is synced ----------

  const DATA_KEYS = new Set(['devsize_playlists', 'devsize_favorites', 'devsize_history']);
  // Settings sync too, except things that belong to this PC or this session, caches, logins and internal flags.
  const PREF_EXCLUDE = /cache|_v\d+$|defaults_|seeded|migrat|welcome|promo|ctx_tip|token|secret|session|password|auth|cookie|lastfm|spotify|discord|^sl_cloud|active_account|volume|muted|sidebar_width|ui_scale|font_scale|offline_plays|recent_moods|wave_skips|daily_mixes|trending|search_history|settings_cat|bg_url|wallpaper$|audio_device|output_device|sink|window|perf_mode|playback_since|listen_seconds|repeat|shuffle|_platform$|riff_platform|offline_only|vault_sort|download_dir|data_dir|overlay|mini_|pinned_tracks|ignored_update|_tip|_shown|_dismissed/i;
  function isSyncedPref(k) {
    return /^(riff_|soulleak_|devsize_|sl_)/.test(k) && !DATA_KEYS.has(k) && !PREF_EXCLUDE.test(k);
  }

  const activeLocalId = () => localStorage.getItem(ACTIVE_KEY) || 'acc_main';

  function parseArr(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }

  function collectLocal() {
    const lib = app.library();
    const prefs = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !isSyncedPref(k)) continue;
      const v = localStorage.getItem(k);
      if (v == null) continue;
      if (k === 'riff_user_avatar' && v.length > MAX_AVATAR_CHARS) continue;
      prefs[k] = v;
    }
    return normalizeVault(clone({
      playlists: lib.playlists, favorites: lib.favorites, history: lib.history, stats: lib.stats, playback: lib.playback, prefs,
    }));
  }

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const arr = (x) => (Array.isArray(x) ? x.filter((v) => v != null) : []);
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

  // Whatever is stored (an empty row "{}", a string, an older or hand-edited vault), the merge always gets lists where
  // it expects lists and objects where it expects objects, so it can never throw on a missing or odd field.
  function normalizeVault(v) {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const prefs = {};
    Object.entries(obj(v.prefs)).forEach(([k, val]) => { if (typeof val === 'string') prefs[k] = val; });
    return {
      v: 1,
      playlists: arr(v.playlists).filter((p) => typeof p === 'object').map((p) => Object.assign({}, p, { tracks: arr(p.tracks).filter((t) => typeof t === 'object') })),
      favorites: arr(v.favorites).filter((t) => typeof t === 'object'),
      history: arr(v.history).filter((t) => typeof t === 'object'),
      stats: arr(v.stats).filter((r) => typeof r === 'object' && r.key != null).map((r) => ({ key: String(r.key), seconds: Math.max(0, Number(r.seconds) || 0), label: r.label || '' })),
      playback: arr(v.playback).filter((r) => typeof r === 'object' && r.month),
      prefs,
    };
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // No playlists and no liked songs here. That is a fresh PC, or a library that was wiped (a reset, a damaged
  // file): either way the cloud copy is restored. Never read as "you deleted everything", which would empty the cloud.
  function isLocalEmpty(local) {
    return local.playlists.length === 0 && local.favorites.length === 0;
  }
  function hasData(v) {
    return !!v && ((v.playlists || []).length > 0 || (v.favorites || []).length > 0 || (v.stats || []).some((r) => r.key === 'total' && r.seconds > 0));
  }

  // ---------- merging ----------

  function trackKey(t) {
    if (!t) return '';
    try { const k = app && app.trackKey ? app.trackKey(t) : ''; if (k) return String(k); } catch (_) {}
    if (t.id) return String(t.id);
    const ta = ((t.title || '') + '|' + (t.artist || '')).toLowerCase();
    return ta !== '|' ? ta : JSON.stringify(t);
  }

  // A list of songs: keep local order, drop what the other PC deleted, add what the other PC added.
  function mergeSongs(L, C, B, newFirst) {
    L = Array.isArray(L) ? L : []; C = Array.isArray(C) ? C : [];
    const inB = B ? new Set(B.map(trackKey)) : null;
    const inC = new Set(C.map(trackKey));
    const out = [];
    for (const x of L) {
      const k = trackKey(x);
      if (k && inB && inB.has(k) && !inC.has(k)) continue; // deleted on the other PC
      out.push(x);
    }
    // Count copies, so a song that is in the list twice on the other PC (and not here) arrives twice.
    const have = new Map();
    out.forEach((x) => { const k = trackKey(x); have.set(k, (have.get(k) || 0) + 1); });
    const added = [];
    for (const x of C) {
      const k = trackKey(x);
      if (!k) continue;
      if (have.get(k)) { have.set(k, have.get(k) - 1); continue; } // already here
      if (inB && inB.has(k)) continue; // deleted on this PC
      added.push(x);
    }
    return newFirst ? added.concat(out) : out.concat(added);
  }

  function mergePlaylists(L, C, B) {
    L = Array.isArray(L) ? L : []; C = Array.isArray(C) ? C : [];
    const cMap = new Map(C.filter((p) => p && p.id).map((p) => [p.id, p]));
    const lIds = new Set(L.filter((p) => p && p.id).map((p) => p.id));
    const bMap = B ? new Map(B.filter((p) => p && p.id).map((p) => [p.id, p])) : null;
    const out = [];
    for (const p of L) {
      if (!p || !p.id) { out.push(p); continue; }
      const c = cMap.get(p.id);
      const b = bMap && bMap.get(p.id);
      if (!c) { if (b) continue; out.push(p); continue; } // gone from the cloud: deleted on the other PC (or new here)
      const merged = {};
      new Set([...Object.keys(c), ...Object.keys(p)]).forEach((k) => {
        if (k === 'tracks') return;
        // A detail (name, cover, description...) keeps the side that changed it; this PC wins a tie.
        merged[k] = (b && same(p[k], b[k]) && k in c) ? c[k] : (k in p ? p[k] : c[k]);
      });
      merged.tracks = mergeSongs(p.tracks, c.tracks, b ? (b.tracks || []) : null, false);
      out.push(merged);
    }
    for (const c of C) {
      if (!c || !c.id || lIds.has(c.id)) continue;
      if (bMap && bMap.has(c.id)) continue; // deleted on this PC
      out.push(c);
    }
    return out;
  }

  function mergeHistory(L, C, B) {
    L = Array.isArray(L) ? L : []; C = Array.isArray(C) ? C : [];
    // History cleared on this PC since the last sync: keep only what the other PC played after that.
    if (B && B.length && !L.length) {
      const inB = new Set(B.map(trackKey));
      return C.filter((x) => !inB.has(trackKey(x))).slice(0, HISTORY_MAX);
    }
    const map = new Map();
    for (const x of [...L, ...C]) {
      const k = trackKey(x);
      if (!k) continue;
      const cur = map.get(k);
      if (!cur || (x.playedAt || 0) > (cur.playedAt || 0)) map.set(k, x);
    }
    return Array.from(map.values()).sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0)).slice(0, HISTORY_MAX);
  }

  function mergeMax(L, C, keyName, valueName) {
    const map = new Map();
    for (const r of [...(L || []), ...(C || [])]) {
      if (!r || r[keyName] == null) continue;
      const cur = map.get(r[keyName]);
      if (!cur || (r[valueName] || 0) > (cur[valueName] || 0)) map.set(r[keyName], r);
    }
    return Array.from(map.values());
  }

  function mergePrefs(L, C, B) {
    const out = {};
    new Set([...Object.keys(L || {}), ...Object.keys(C || {})]).forEach((k) => {
      const inL = L && k in L;
      const inC = C && k in C;
      if (B && inL && inC && B[k] === L[k]) out[k] = C[k];      // unchanged here: take the other PC's change
      else if (inL) out[k] = L[k];
      else if (inC) out[k] = C[k];
    });
    return out;
  }

  function merge(local, cloud, base) {
    local = normalizeVault(local) || normalizeVault({});
    cloud = normalizeVault(cloud);
    base = normalizeVault(base);
    if (!cloud) return clone(local);
    // A list that is suddenly empty in the cloud while it had items at the last sync is a broken or wiped row, not
    // "the other PC deleted everything": nothing is deleted here because of it (the mirror of the fresh-PC rule).
    const wiped = (key) => base && base[key].length > 0 && cloud[key].length === 0;
    return {
      v: 1,
      playlists: mergePlaylists(local.playlists, cloud.playlists, wiped('playlists') ? null : base && base.playlists),
      favorites: mergeSongs(local.favorites, cloud.favorites, base && !wiped('favorites') ? base.favorites : null, true),
      history: mergeHistory(local.history, cloud.history, base && base.history),
      stats: mergeMax(local.stats, cloud.stats, 'key', 'seconds'),
      playback: mergeMax(local.playback, cloud.playback, 'month', 'totalSeconds'),
      prefs: mergePrefs(local.prefs, cloud.prefs, base && base.prefs),
    };
  }

  // ---------- syncing ----------

  function setStatusText() { render(); }

  async function refreshStatus() {
    const a = api();
    if (!a) { status = { signedIn: false, unavailable: true }; return status; }
    let r = null;
    try { r = await a.status(); } catch (_) { r = null; }
    status = r && r.ok ? r : { signedIn: false };
    return status;
  }

  const linkedHere = () => !status.localAccountId || status.localAccountId === activeLocalId();

  function schedule(delay = DEBOUNCE_MS) {
    if (!status.signedIn || suppressSchedule) return;
    clearTimeout(timer);
    timer = setTimeout(() => syncNow('change'), delay);
  }

  async function waitReady() {
    for (let i = 0; i < 50 && app && app.ready && !app.ready(); i++) await new Promise((r) => setTimeout(r, 200));
  }

  async function syncNow(reason) {
    const a = api();
    if (!a || !app) return { ok: false };
    if (syncing) { again = true; return { ok: false, busy: true }; }
    clearTimeout(timer);
    if (!status.signedIn) return { ok: false };
    if (!linkedHere()) { render(); return { ok: false, paused: true }; }
    syncing = true;
    lastError = '';
    render();
    let reloadAfter = false;
    try {
      await waitReady();
      if (app.flush) app.flush();
      await new Promise((r) => setTimeout(r, 150));
      const local = collectLocal();
      const before = librarySignature(local);
      const pulled = await a.pull();
      if (!pulled || !pulled.ok) throw pulled || { error: 'Sync failed' };
      // An empty row ({}), or one without a library in it, counts as "nothing in the cloud yet".
      const cloud = pulled.vault ? normalizeVault(pulled.vault) : null;
      const cloudHasVault = !!cloud && hasData(cloud);
      const baseRes = await a.getBase();
      const base = baseRes && baseRes.ok ? normalizeVault(baseRes.base) : null;
      const fresh = isLocalEmpty(local) && cloudHasVault;
      // Fresh / wiped PC: the cloud library exactly as it is (duplicates and order kept), listening time at its
      // highest, and the cloud's settings (theme...) instead of this PC's defaults.
      const merged = fresh
        ? Object.assign(clone(cloud), {
          history: mergeHistory(local.history, cloud.history, null),
          stats: mergeMax(local.stats, cloud.stats, 'key', 'seconds'),
          playback: mergeMax(local.playback, cloud.playback, 'month', 'totalSeconds'),
          prefs: Object.assign({}, local.prefs, cloud.prefs),
        })
        : merge(local, cloudHasVault || (cloud && cloud.prefs && Object.keys(cloud.prefs).length) ? cloud : null, base);

      // Something changed here while the cloud was answering (a song added, a playlist edited): putting the merge
      // in place now would undo it. Drop this round and try again in a moment with the new state.
      if (librarySignature(collectLocal()) !== before) { retrySoon = true; return { ok: false, retry: true }; }

      // Put the merged library in place on this PC (only what actually changed).
      const next = {};
      if (!same(merged.playlists, local.playlists)) next.playlists = merged.playlists;
      if (!same(merged.favorites, local.favorites)) next.favorites = merged.favorites;
      if (!same(merged.history, local.history)) next.history = merged.history;
      if (!same(merged.stats, local.stats)) next.stats = merged.stats;
      if (!same(merged.playback, local.playback)) next.playback = merged.playback;
      const prefChanges = {};
      Object.entries(merged.prefs || {}).forEach(([k, v]) => { if (local.prefs[k] !== v) prefChanges[k] = v; });
      if (Object.keys(prefChanges).length) next.prefs = prefChanges;
      if (Object.keys(next).length) {
        suppressSchedule++;
        try { app.apply(next); } finally { suppressSchedule--; }
        // A restored library brings its theme and settings along: those take effect on a fresh start of the page.
        if (fresh && next.prefs) reloadAfter = true;
      }

      let pushedAt = null;
      if (!cloudHasVault || !same(cloud, merged)) {
        const vault = Object.assign({}, merged, { savedAt: new Date().toISOString(), app: (app.version && app.version()) || '' });
        const pushed = await a.push(vault);
        if (!pushed || !pushed.ok) throw pushed || { error: 'Sync failed' };
        pushedAt = pushed;
      }
      await a.setBase(merged);
      localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
      lastCloudUpdatedAt = (pushedAt && pushedAt.updatedAt) || pulled.updatedAt || null;
      lastSyncSig = librarySignature(merged);
      lastFullSync = Date.now();
      offline = false;
      if (fresh) {
        if (reloadAfter) { try { sessionStorage.setItem('sl_cloud_restored', '1'); } catch (_) {} }
        else toast('Your library was restored from Soulleak Cloud', 'success');
      } else if (reason === 'manual') {
        toast('Soulleak Cloud is up to date', 'success');
      }
      return { ok: true, changedHere: Object.keys(next) };
    } catch (e) {
      lastError = (e && e.error) || (e && e.message) || 'Sync failed';
      offline = !!(e && e.offline);
      if (e && e.signedOut) { await refreshStatus(); }
      if (reason === 'manual') toast(lastError, 'error');
      return { ok: false, error: lastError };
    } finally {
      syncing = false;
      render();
      if (reloadAfter) setTimeout(() => location.reload(), 300);
      else if (again || retrySoon) { again = false; retrySoon = false; schedule(1500); }
    }
  }
  let retrySoon = false;
  let lastCloudUpdatedAt = null;
  let lastSyncSig = '';
  let lastFullSync = 0;
  let lastCheck = 0;

  // Cheap check, run when the window gets focus and every 2 minutes: a full sync only when the cloud changed since
  // the last sync (another PC saved something), when something here changed, or for the 10-minute listening-time sync.
  async function quickCheck(reason) {
    const a = api();
    if (!a || !app || !status.signedIn || syncing || !linkedHere()) return;
    if (reason === 'focus' && Date.now() - lastCheck < FOCUS_GAP_MS) return;
    lastCheck = Date.now();
    if (!lastFullSync || Date.now() - lastFullSync > PERIODIC_MS) { syncNow(reason); return; }
    try { if (librarySignature(collectLocal()) !== lastSyncSig) { syncNow(reason); return; } } catch (_) {}
    let head = null;
    try { head = await a.head(); } catch (_) { head = null; }
    if (!head || !head.ok) {
      if (head && head.signedOut) { await refreshStatus(); render(); return; }
      if (head && head.offline && !offline) { offline = true; render(); }
      return;
    }
    if (offline) { offline = false; render(); }
    if (head.updatedAt !== lastCloudUpdatedAt) syncNow(reason);
  }
  // What a sync must not overwrite: the library and settings. Listening time is left out on purpose (it ticks every
  // second while music plays, and it only ever goes up: the merge takes the higher value, so it can't be undone).
  const librarySignature = (v) => JSON.stringify([v.playlists, v.favorites, v.history, v.prefs]);

  // ---------- watching for changes ----------

  function watchStorage() {
    const proto = Storage.prototype;
    const set = proto.setItem;
    const rem = proto.removeItem;
    const touched = (k) => (DATA_KEYS.has(k) || isSyncedPref(k));
    proto.setItem = function (k, v) {
      const r = set.call(this, k, v);
      if (this === window.localStorage && touched(String(k))) schedule();
      return r;
    };
    proto.removeItem = function (k) {
      const r = rem.call(this, k);
      if (this === window.localStorage && touched(String(k))) schedule();
      return r;
    };
  }

  // ---------- Account card ----------

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function toast(msg, type) { if (app && app.toast) app.toast(msg, type); }
  let mode = 'signin';
  let formError = '';
  let formBusy = false;

  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function statusLine() {
    if (!linkedHere()) return { cls: 'is-paused', text: 'Paused: this cloud account belongs to another local account on this PC' };
    if (syncing) return { cls: 'is-syncing', text: 'Syncing…' };
    if (offline) return { cls: 'is-offline', text: 'Offline: changes will sync when you\'re back online' };
    if (lastError) return { cls: 'is-error', text: lastError };
    const last = parseInt(localStorage.getItem(LAST_SYNC_KEY) || '0', 10);
    return last ? { cls: 'is-ok', text: `Cloud synced · ${ago(last)}` } : { cls: 'is-syncing', text: 'Not synced yet' };
  }

  function render() {
    const host = document.getElementById('sl-cloud-card');
    if (!host) return;
    if (status.unavailable) { host.hidden = true; return; }
    host.hidden = false;
    if (status.signedIn) {
      const name = status.username || (status.email || '').split('@')[0] || 'You';
      const avatar = localStorage.getItem('riff_user_avatar') || '';
      const st = statusLine();
      host.innerHTML = `
        <div class="slc-head">
          <span class="slc-logo" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6.5 19a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.6 8.5 5 5 0 0 1 17.5 19h-11Z"/></svg></span>
          <span class="slc-title">Soulleak Cloud</span>
        </div>
        <div class="slc-user">
          <span class="slc-avatar">${avatar && /^(data:image|https?:)/.test(avatar) ? `<img src="${esc(avatar)}" alt="">` : esc(name.charAt(0).toUpperCase())}</span>
          <span class="slc-who"><span class="slc-name">${esc(name)}</span><span class="slc-email">${esc(status.email || '@' + name)}</span></span>
        </div>
        <div class="slc-status ${st.cls}"><span class="slc-dot"></span><span>${esc(st.text)}</span></div>
        <div class="slc-actions">
          <button type="button" class="slc-btn slc-primary" data-slc="sync" ${syncing || !linkedHere() ? 'disabled' : ''}>${syncing ? 'Syncing…' : 'Sync now'}</button>
          <button type="button" class="slc-btn" data-slc="signout">Log out</button>
        </div>
        <p class="slc-note">Playlists, liked songs, history, rank, Soul Playback and settings sync automatically on every PC you sign in on.</p>`;
    } else {
      const up = mode === 'signup';
      host.innerHTML = `
        <div class="slc-head">
          <span class="slc-logo" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6.5 19a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.6 8.5 5 5 0 0 1 17.5 19h-11Z"/></svg></span>
          <span class="slc-title">Soulleak Cloud</span>
        </div>
        <p class="slc-note">Sign in to keep your playlists, liked songs, history and rank on every PC. Nothing on this PC is removed. No email needed: just a username and a password.</p>
        <div class="slc-tabs" role="tablist">
          <button type="button" role="tab" class="slc-tab ${up ? '' : 'active'}" data-slc-mode="signin" aria-selected="${!up}">Sign in</button>
          <button type="button" role="tab" class="slc-tab ${up ? 'active' : ''}" data-slc-mode="signup" aria-selected="${up}">Create account</button>
        </div>
        <form class="slc-form" novalidate>
          <label class="slc-field"><span>Username</span><input type="text" name="username" maxlength="20" autocomplete="username" autocapitalize="off" spellcheck="false" required placeholder="${up ? 'a-z, 0-9 and _' : ''}"></label>
          <label class="slc-field"><span>Password</span><input type="password" name="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="6" required placeholder="${up ? 'At least 6 characters' : ''}"></label>
          ${up ? '<p class="slc-hint">Remember your password: with no email on the account, it can\'t be reset.</p>' : ''}
          <p class="slc-error" ${formError ? '' : 'hidden'}>${esc(formError)}</p>
          <button type="submit" class="slc-btn slc-primary slc-submit" ${formBusy ? 'disabled' : ''}>${formBusy ? 'Please wait…' : (up ? 'Create account' : 'Sign in')}</button>
        </form>`;
    }
  }

  async function submitForm(form) {
    const a = api();
    if (!a || formBusy) return;
    const f = new FormData(form);
    const username = String(f.get('username') || '').trim().toLowerCase();
    const password = String(f.get('password') || '');
    const keep = { username };
    formError = '';
    if (!username || !password) formError = 'Enter your username and password.';
    else if (mode === 'signup' && !/^[a-z0-9_]{3,20}$/.test(username)) formError = 'Usernames are 3 to 20 characters: a-z, 0-9 and _.';
    else if (mode === 'signup' && password.length < 6) formError = 'Choose a longer password (at least 6 characters).';
    if (formError) { render(); refill(keep); return; }
    formBusy = true;
    render(); refill(keep);
    let res = null;
    try {
      res = mode === 'signup'
        ? await a.signUp({ username, password, localAccountId: activeLocalId() })
        : await a.signIn({ username, password, localAccountId: activeLocalId() });
    } catch (e) {
      res = { ok: false, error: 'Soulleak Cloud didn\'t answer. Try again in a moment.' };
    }
    formBusy = false;
    if (!res || !res.ok) { formError = (res && res.error) || 'Something went wrong. Try again.'; render(); refill(keep); return; }
    if (res.needsConfirm) {
      mode = 'signin';
      formError = 'Your account was created. Sign in with your username and password.';
      render(); refill({ username });
      return;
    }
    status = res;
    render();
    toast(mode === 'signup' ? `Welcome, ${res.username}! Your library is being backed up to Soulleak Cloud` : `Signed in as ${res.username}`, 'success');
    syncNow('signin');
  }

  function refill({ username }) {
    const host = document.getElementById('sl-cloud-card');
    if (!host) return;
    const u = host.querySelector('input[name="username"]');
    if (u && username) u.value = username;
  }

  function wire() {
    const host = document.getElementById('sl-cloud-card');
    if (!host || host._wired) return;
    host._wired = true;
    host.addEventListener('click', async (e) => {
      const tab = e.target.closest('[data-slc-mode]');
      if (tab) { mode = tab.dataset.slcMode; formError = ''; render(); return; }
      const btn = e.target.closest('[data-slc]');
      if (!btn) return;
      if (btn.dataset.slc === 'sync') syncNow('manual');
      if (btn.dataset.slc === 'signout') {
        // Push what's here first, so nothing done since the last sync is left behind.
        if (linkedHere()) await syncNow('signout');
        let r = null;
        try { r = await api().signOut(); } catch (_) { r = null; }
        status = r && r.ok ? r : { signedIn: false };
        lastError = ''; offline = false;
        localStorage.removeItem(LAST_SYNC_KEY);
        render();
        toast('Logged out of Soulleak Cloud. Your library stays on this PC', 'info');
      }
    });
    host.addEventListener('submit', (e) => { e.preventDefault(); submitForm(e.target); });
    // Usernames are lowercase: type "Soul" and it becomes "soul".
    host.addEventListener('input', (e) => {
      const t = e.target;
      if (t && t.name === 'username' && t.value !== t.value.toLowerCase()) {
        const at = t.selectionStart;
        t.value = t.value.toLowerCase();
        try { t.setSelectionRange(at, at); } catch (_) {}
      }
    });
  }

  // ---------- start ----------

  async function start() {
    await refreshStatus();
    wire();
    render();
    watchStorage();
    try {
      if (sessionStorage.getItem('sl_cloud_restored')) { sessionStorage.removeItem('sl_cloud_restored'); setTimeout(() => toast('Your library was restored from Soulleak Cloud', 'success'), 1200); }
    } catch (_) {}
    if (!status.signedIn) return;
    // Offline-first: the app is already running from this PC's data; the first sync comes a moment later.
    setTimeout(() => syncNow('startup'), 3000);
  }

  setInterval(() => quickCheck('periodic'), CHECK_MS);
  // Coming back to Soulleak (clicking into it, alt-tabbing out of a game) picks up what another PC saved.
  window.addEventListener('focus', () => quickCheck('focus'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) quickCheck('focus'); });
  setInterval(() => { if (document.getElementById('sl-cloud-card') && status.signedIn && !syncing) render(); }, 30000);
  window.addEventListener('online', () => { if (status.signedIn) syncNow('online'); });
  if (window.electronAPI && window.electronAPI.onAppExiting) window.electronAPI.onAppExiting(() => { if (status.signedIn) syncNow('quit'); });

  function attach(adapter) {
    app = adapter;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  window.SoulleakCloud = { attach, syncNow: () => syncNow('manual'), status: () => Object.assign({}, status), _merge: merge, _isSyncedPref: isSyncedPref };
  if (typeof module !== 'undefined') module.exports = { merge, mergeSongs, mergePlaylists, mergeHistory, mergePrefs, isSyncedPref };
})();
