// Listen Together: synced playback with friends, peer to peer.
//
// One person hosts a room; friends join with its 6-letter code. Apps talk directly over WebRTC (PeerJS, whose free
// public server is only used for the first handshake). Only small control messages travel: which song, playing or
// paused, and where in the song. Every app streams the audio itself.
//
// Anyone in the room can change the song, pause, play or seek. The host orders those changes (each one gets the next
// version number) and passes them to everyone, so all apps end up on the last change. The host is also the clock:
// guests measure their offset to it, and drift back to the host's position if they fall more than 2 s out of sync.
//
// app.js hands this module a small adapter through attach() and calls notify() when the user changes playback.
(function () {
  'use strict';

  const ID_PREFIX = 'soulleak-lt-';
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 6;
  const NAME_KEY = 'soulleak_lt_name';
  const CONNECT_TIMEOUT_MS = 15000;
  const DRIFT_CHECK_MS = 2000;
  const GUEST_DRIFT_S = 2;
  const HOST_DRIFT_S = 1.5;
  const SEEK_TOLERANCE_S = 1.2;

  let app = null;
  let peer = null;
  let room = null;
  let notifyTimer = null;
  let driftTimer = null;
  let pingTimer = null;
  let applyToken = 0;
  let applyingUntil = 0;
  let pendingLocalTrack = null;
  let localFileWarned = false;
  let seekListenerOn = false;
  let reconciledFor = null;
  let ui = null;

  // ---------- helpers ----------

  function now() { return Date.now(); }
  function hostNow() { return now() + (room ? room.offset : 0); }
  function isApplying() { return now() < applyingUntil; }

  function makeCode() {
    let s = '';
    const buf = new Uint32Array(CODE_LEN);
    crypto.getRandomValues(buf);
    for (let i = 0; i < CODE_LEN; i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
    return s;
  }

  function normalizeCode(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
  }

  function getName() {
    let n = '';
    try { n = localStorage.getItem(NAME_KEY) || ''; } catch (_) {}
    n = n.trim().slice(0, 24);
    if (!n) {
      n = 'Soul' + Math.floor(1000 + Math.random() * 9000);
      try { localStorage.setItem(NAME_KEY, n); } catch (_) {}
    }
    return n;
  }

  function setName(n) {
    const clean = String(n || '').trim().slice(0, 24);
    if (!clean) return;
    try { localStorage.setItem(NAME_KEY, clean); } catch (_) {}
  }

  function keyOf(t) {
    if (!t || !t.id) return '';
    return (t.platform || 'youtube') + ':' + t.id;
  }

  // Only what another app needs to find and play the song: no private, cached or per-device fields.
  function serializeTrack(t) {
    if (!t) return null;
    const out = {};
    for (const k of Object.keys(t)) {
      if (k.startsWith('_') || k === 'playedAt' || k === 'addedAt' || k === 'isCached' || k === 'localPath' || k === 'path' || k === 'filePath') continue;
      const v = t[k];
      if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        if (typeof v === 'string' && v.length > 2048) continue;
        out[k] = v;
      }
    }
    return out;
  }

  // A song that came from another app: keep only a plain streaming track. No local files or paths from someone
  // else's disk, a sane id, and links that are https only.
  const REMOTE_PLATFORMS = new Set(['youtube', 'ytmusic', 'soundcloud', 'deezer', 'yandex']);
  const LINK_KEYS = new Set(['url', 'thumbnail', 'cover', 'artwork', 'image', 'permalink']);
  function sanitizeTrack(t) {
    const s = serializeTrack(t && typeof t === 'object' ? t : null);
    if (!s) return null;
    s.platform = String(s.platform || 'youtube');
    if (!REMOTE_PLATFORMS.has(s.platform)) return null;
    if (!/^[A-Za-z0-9_\-:.]{1,128}$/.test(String(s.id || ''))) return null;
    s.id = String(s.id);
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (typeof v !== 'string') continue;
      if (LINK_KEYS.has(k) && !/^https:\/\//i.test(v)) { delete s[k]; continue; }
      if (/^file:|^[a-z]:\\|^\\\\/i.test(v)) { delete s[k]; continue; }
      if (v.length > 512) s[k] = v.slice(0, 512);
    }
    return s;
  }

  function sanitizeState(s) {
    if (!s || typeof s !== 'object') return null;
    const track = sanitizeTrack(s.track);
    if (!track) return null;
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      track,
      playing: !!s.playing,
      pos: Math.max(0, Math.min(86400, num(s.pos, 0))),
      rate: Math.max(0.25, Math.min(4, num(s.rate, 1))),
      at: num(s.at, now()),
      v: num(s.v, 0),
      by: String(s.by || '').slice(0, 64),
    };
  }

  function audio() { return app && app.audio ? app.audio() : null; }
  function curPos() {
    const a = audio();
    return a && Number.isFinite(a.currentTime) ? a.currentTime : 0;
  }
  function curRate() {
    const a = audio();
    return a && Number.isFinite(a.playbackRate) && a.playbackRate > 0 ? a.playbackRate : 1;
  }

  function expectedPos(s) {
    if (!s) return 0;
    if (!s.playing) return s.pos || 0;
    return (s.pos || 0) + Math.max(0, hostNow() - (s.at || hostNow())) / 1000 * (s.rate || 1);
  }

  function toast(msg, type) {
    if (app && app.toast) { try { app.toast(msg, type || 'info'); } catch (_) {} }
  }

  function send(conn, msg) {
    if (!conn || !conn.open) return;
    try { conn.send(msg); } catch (e) { console.warn('[Listen Together] send failed:', e); }
  }

  function broadcast(msg) {
    if (!room || !room.isHost) return;
    for (const g of room.guests.values()) send(g.conn, msg);
  }

  function memberList() {
    if (!room) return [];
    if (!room.isHost) return room.members || [];
    const list = [{ id: room.selfId, name: room.name, host: true }];
    for (const g of room.guests.values()) if (g.name) list.push({ id: g.id, name: g.name, host: false });
    return list;
  }

  function nameOf(id) {
    const m = memberList().find((x) => x.id === id);
    return m ? m.name : 'Someone';
  }

  // ---------- local playback → room ----------

  function snapshot() {
    const cur = app.getTrack();
    if (pendingLocalTrack && keyOf(cur) === keyOf(pendingLocalTrack) && !app.isLoading()) pendingLocalTrack = null;
    const track = pendingLocalTrack || cur;
    const loading = !!pendingLocalTrack || app.isLoading();
    return {
      track,
      playing: loading ? true : app.isPlaying(),
      pos: loading ? 0 : curPos(),
      rate: curRate(),
    };
  }

  function evaluateLocal() {
    notifyTimer = null;
    if (!room || !room.ready || !app || isApplying()) return;
    const snap = snapshot();
    if (!snap.track) return;
    if (snap.track.platform === 'local') {
      if (!localFileWarned) {
        localFileWarned = true;
        toast("Local files aren't shared in Listen Together. Your friends keep their song.", 'info');
      }
      return;
    }
    const s = room.state;
    const changed = !s
      || keyOf(s.track) !== keyOf(snap.track)
      || !!s.playing !== !!snap.playing
      || Math.abs(expectedPos(s) - snap.pos) > HOST_DRIFT_S;
    if (!changed) return;
    propose({ track: serializeTrack(snap.track), playing: snap.playing, pos: snap.pos, rate: snap.rate });
  }

  function propose(p) {
    if (!room) return;
    const msg = Object.assign({}, p, { at: hostNow() });
    if (room.isHost) {
      commit(msg, room.selfId);
    } else {
      // Optimistic: keep the change locally until the host's numbered copy comes back.
      room.state = Object.assign({}, msg, { v: room.state ? room.state.v : 0, by: room.selfId });
      send(room.conn, { t: 'propose', s: msg });
    }
  }

  // Host only: number a change, pass it to everyone, and follow it if it came from a guest.
  function commit(msg, fromId) {
    const prev = room.state;
    room.version += 1;
    room.state = Object.assign({}, msg, { v: room.version, by: fromId });
    broadcast({ t: 'state', s: room.state });
    if (fromId !== room.selfId) {
      announce(prev, room.state);
      applyState(room.state);
    }
    renderUI();
  }

  function announce(prev, next) {
    if (!next || !next.track || next.by === room.selfId) return;
    if (!prev || keyOf(prev.track) !== keyOf(next.track)) {
      toast(`${nameOf(next.by)} played "${next.track.title || 'a song'}"`, 'info');
    }
  }

  // ---------- room → local playback ----------

  // Resolves once the song has loaded. Audio events wake it right away; the slow timer is only a backup, since
  // timers in a minimized window (Soulleak behind a game) can be held back by the browser.
  function waitForTrackReady(key, token, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = now();
      const a = audio();
      const events = ['loadeddata', 'canplay', 'playing', 'timeupdate'];
      let timer = null;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (a) events.forEach((ev) => a.removeEventListener(ev, tick));
        resolve(ok);
      };
      function tick() {
        if (done) return;
        if (token !== applyToken) return finish(false);
        const el = audio();
        if (keyOf(app.getTrack()) === key && !app.isLoading() && el && el.readyState >= 2) return finish(true);
        if (now() - t0 > timeoutMs) return finish(false);
        if (timer) clearTimeout(timer);
        timer = setTimeout(tick, 250);
      }
      if (a) events.forEach((ev) => a.addEventListener(ev, tick));
      tick();
    });
  }

  function matchesLocal(s) {
    if (keyOf(app.getTrack()) !== keyOf(s.track) || app.isLoading()) return false;
    if (!!s.playing !== !!app.isPlaying()) return false;
    return Math.abs(curPos() - expectedPos(s)) <= SEEK_TOLERANCE_S;
  }

  async function applyState(s) {
    if (!app || !s || !s.track) return;
    // Already there (usually our own change coming back): nothing to do, and nothing to block.
    if (matchesLocal(s)) return;
    const token = ++applyToken;
    const key = keyOf(s.track);
    applyingUntil = now() + 20000;
    pendingLocalTrack = null;
    try {
      if (keyOf(app.getTrack()) !== key) {
        await app.playTrack(Object.assign({}, s.track));
        const ok = await waitForTrackReady(key, token, 18000);
        if (token !== applyToken) return;
        if (!ok) { applyingUntil = now() + 1500; return; }
      }
      if (token !== applyToken) return;
      const a = audio();
      if (!a) return;
      const dur = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
      let target = expectedPos(s);
      if (dur) target = Math.min(target, Math.max(0, dur - 1));
      if (Math.abs(curPos() - target) > SEEK_TOLERANCE_S) {
        try { a.currentTime = target; } catch (_) {}
      }
      if (s.playing && !app.isPlaying()) await app.play();
      else if (!s.playing && app.isPlaying()) app.pause();
    } catch (e) {
      console.warn('[Listen Together] apply failed:', e);
    } finally {
      if (token === applyToken) applyingUntil = now() + 1200;
    }
  }

  // Every couple of seconds: guests drift back to the room; the host re-anchors the room if it stalled itself.
  function checkDrift() {
    if (!room || !room.ready || !room.state || !app || isApplying()) return;
    const s = room.state;
    if (app.isLoading() || notifyTimer || pendingLocalTrack) return;
    const cur = app.getTrack();
    if (keyOf(cur) !== keyOf(s.track)) {
      // Ended up on a different song than the room (e.g. two changes crossed while loading): rejoin it, once per
      // change so a song that won't load can't loop. A local file someone chose on purpose is left alone.
      if (s.track && (!cur || cur.platform !== 'local') && reconciledFor !== s) {
        reconciledFor = s;
        applyState(s);
      }
      return;
    }
    if (!s.playing || !app.isPlaying()) return;
    // Different speed presets drift apart by design; only song, pause and seek stay shared then.
    if (Math.abs(curRate() - (s.rate || 1)) > 0.01) return;
    const drift = curPos() - expectedPos(s);
    if (room.isHost) {
      if (Math.abs(drift) > HOST_DRIFT_S) propose({ track: s.track, playing: true, pos: curPos(), rate: curRate() });
    } else if (Math.abs(drift) > GUEST_DRIFT_S) {
      const a = audio();
      applyingUntil = now() + 1000;
      try { a.currentTime = expectedPos(s); } catch (_) {}
    }
  }

  // ---------- networking ----------

  // PeerJS's built-in TURN relays (eu-0/us-0.turn.peerjs.com) no longer resolve, so only STUN is listed: it finds
  // each app's public address so they can connect directly, which works on most home networks. A TURN relay for
  // strict networks can be added to RELAY_SERVERS later.
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const RELAY_SERVERS = [];

  function newPeer(id) {
    if (typeof window.Peer !== 'function') throw new Error('PeerJS is missing');
    const opts = { debug: 1, config: { iceServers: ICE_SERVERS.concat(RELAY_SERVERS) } };
    return id ? new window.Peer(id, opts) : new window.Peer(opts);
  }

  const BLOCKED_MSG = "Found the room, but your networks won't let the apps connect directly. Try another network (e.g. home Wi-Fi instead of mobile data or school/work Wi-Fi).";

  function startRoom(attempt = 0) {
    if (room) return;
    const code = makeCode();
    const name = getName();
    room = { isHost: true, code, name, selfId: ID_PREFIX + code.toLowerCase(), guests: new Map(), state: null, version: 0, offset: 0, ready: false };
    renderUI('connecting');
    let p;
    try { p = newPeer(room.selfId); } catch (e) { failRoom("Couldn't start Listen Together."); return; }
    peer = p;
    const timeout = setTimeout(() => { if (room && !room.ready && peer === p) failRoom("Couldn't reach the connection service. Check your internet."); }, CONNECT_TIMEOUT_MS);
    p.on('open', () => {
      clearTimeout(timeout);
      if (peer !== p || !room) return;
      room.ready = true;
      startTimers();
      // Seed the room with whatever is on right now.
      const cur = app && app.getTrack();
      if (cur && cur.platform !== 'local') {
        commit({ track: serializeTrack(cur), playing: app.isPlaying(), pos: curPos(), rate: curRate(), at: hostNow() }, room.selfId);
      }
      renderUI();
      toast(`Room ${code} is open. Share the code with your friends.`, 'success');
    });
    p.on('connection', (conn) => onGuestConnection(conn));
    p.on('disconnected', () => { if (peer === p && room) { try { p.reconnect(); } catch (_) {} } });
    p.on('error', (err) => {
      clearTimeout(timeout);
      if (peer !== p) return;
      const type = err && err.type;
      if (type === 'unavailable-id' && attempt < 3) {
        teardown();
        startRoom(attempt + 1);
        return;
      }
      if (room && room.ready && (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed')) {
        // Friends already connected stay connected; only new joins wait for the signaling server to come back.
        console.warn('[Listen Together] signaling issue:', type);
        return;
      }
      if (room && room.ready) return;
      failRoom("Couldn't start Listen Together.");
    });
  }

  function onGuestConnection(conn) {
    if (!room || !room.isHost) { try { conn.close(); } catch (_) {} return; }
    const g = { id: conn.peer, conn, name: '' };
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object' || !room) return;
      if (msg.t === 'hello') {
        g.name = String(msg.name || 'Friend').slice(0, 24);
        room.guests.set(g.id, g);
        send(conn, { t: 'welcome', s: room.state, v: room.version, members: memberList(), code: room.code });
        broadcast({ t: 'members', members: memberList() });
        toast(`${g.name} joined the room`, 'info');
        renderUI();
      } else if (msg.t === 'ping') {
        send(conn, { t: 'pong', c: msg.c, h: now() });
      } else if (msg.t === 'propose' && room.guests.has(g.id)) {
        const s = sanitizeState(msg.s);
        if (s) commit({ track: s.track, playing: s.playing, pos: s.pos, rate: s.rate, at: s.at }, g.id);
      }
    });
    conn.on('close', () => {
      if (!room || !room.guests.has(g.id)) return;
      room.guests.delete(g.id);
      broadcast({ t: 'members', members: memberList() });
      toast(`${g.name || 'A friend'} left the room`, 'info');
      renderUI();
    });
    conn.on('error', () => {});
  }

  function joinRoom(rawCode) {
    if (room) return;
    const code = normalizeCode(rawCode);
    if (code.length !== CODE_LEN) { toast('Room codes are 6 letters and numbers.', 'error'); return; }
    const name = getName();
    room = { isHost: false, code, name, selfId: '', hostId: ID_PREFIX + code.toLowerCase(), conn: null, state: null, members: [], offset: 0, ready: false, bestRtt: Infinity };
    renderUI('connecting');
    let p;
    try { p = newPeer(null); } catch (e) { failRoom("Couldn't start Listen Together."); return; }
    peer = p;
    let signaled = false;
    const timeout = setTimeout(() => {
      if (!room || room.ready || peer !== p) return;
      // The signaling server answered for this code but no direct link came up: a network problem, not a bad code.
      failRoom(signaled ? BLOCKED_MSG : "Couldn't reach the connection service. Check your internet.");
    }, CONNECT_TIMEOUT_MS);
    p.on('open', (id) => {
      if (peer !== p || !room) return;
      signaled = true;
      room.selfId = id;
      const conn = p.connect(room.hostId, { reliable: true, serialization: 'json' });
      room.conn = conn;
      conn.on('iceStateChanged', (st) => {
        if (st === 'failed' && room && !room.ready && room.conn === conn) {
          clearTimeout(timeout);
          failRoom(BLOCKED_MSG);
        }
      });
      conn.on('open', () => {
        if (!room || room.conn !== conn) return;
        send(conn, { t: 'hello', name });
        measureClock();
      });
      conn.on('data', (msg) => onHostMessage(msg, timeout));
      conn.on('close', () => {
        if (!room || room.conn !== conn) return;
        const wasReady = room.ready;
        clearTimeout(timeout);
        teardown();
        toast(wasReady ? 'The host left, so the room closed.' : BLOCKED_MSG, wasReady ? 'info' : 'error');
      });
      conn.on('error', () => {});
    });
    p.on('disconnected', () => { if (peer === p && room) { try { p.reconnect(); } catch (_) {} } });
    p.on('error', (err) => {
      if (peer !== p) return;
      const type = err && err.type;
      if (room && room.ready) { console.warn('[Listen Together] signaling issue:', type); return; }
      clearTimeout(timeout);
      failRoom(type === 'peer-unavailable' ? 'No room with that code. Check it and try again.' : "Couldn't connect to that room.");
    });
  }

  function onHostMessage(msg, connectTimeout) {
    if (!msg || typeof msg !== 'object' || !room || room.isHost) return;
    if (msg.t === 'welcome') {
      clearTimeout(connectTimeout);
      room.ready = true;
      room.members = Array.isArray(msg.members) ? msg.members : [];
      startTimers();
      toast(`Joined room ${room.code}`, 'success');
      const s = sanitizeState(msg.s);
      if (s) { room.state = s; room.lastV = s.v; applyState(s); }
      renderUI();
    } else if (msg.t === 'state') {
      const s = sanitizeState(msg.s);
      if (!s || s.v <= (room.lastV || 0)) return;
      room.lastV = s.v;
      const prev = room.state;
      room.state = s;
      announce(prev, s);
      // Applied even when it's our own change: if someone else's change landed in between, this puts us back in line.
      applyState(s);
      renderUI();
    } else if (msg.t === 'members') {
      room.members = Array.isArray(msg.members)
        ? msg.members.slice(0, 50).map((m) => ({ id: String((m && m.id) || '').slice(0, 64), name: String((m && m.name) || 'Friend').slice(0, 24), host: !!(m && m.host) }))
        : [];
      renderUI();
    } else if (msg.t === 'pong') {
      const t1 = now();
      const rtt = t1 - msg.c;
      if (rtt >= 0 && rtt < room.bestRtt + 30) {
        if (rtt < room.bestRtt) room.bestRtt = rtt;
        room.offset = msg.h - (msg.c + t1) / 2;
      }
    }
  }

  // A few pings to estimate the clock offset to the host (the fastest round trip wins).
  function measureClock() {
    if (!room || room.isHost) return;
    for (let i = 0; i < 5; i++) setTimeout(() => { if (room && room.conn) send(room.conn, { t: 'ping', c: now() }); }, i * 250);
  }

  function startTimers() {
    stopTimers();
    driftTimer = setInterval(checkDrift, DRIFT_CHECK_MS);
    if (!room.isHost) pingTimer = setInterval(() => { if (room) { room.bestRtt += 20; measureClock(); } }, 30000);
    if (!seekListenerOn) {
      const a = audio();
      if (a) {
        a.addEventListener('seeked', () => notify('seek'));
        seekListenerOn = true;
      }
    }
  }

  function stopTimers() {
    if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
  }

  function teardown() {
    stopTimers();
    applyToken++;
    applyingUntil = 0;
    pendingLocalTrack = null;
    localFileWarned = false;
    const p = peer;
    const r = room;
    peer = null;
    room = null;
    reconciledFor = null;
    if (r) {
      if (r.isHost) for (const g of r.guests.values()) { try { g.conn.close(); } catch (_) {} }
      else if (r.conn) { try { r.conn.close(); } catch (_) {} }
    }
    if (p) { try { p.destroy(); } catch (_) {} }
    renderUI();
  }

  function failRoom(msg) {
    teardown();
    toast(msg, 'error');
  }

  // ---------- public API ----------

  function notify(kind, track) {
    if (!room || !room.ready || isApplying()) return;
    if (kind === 'track' && track) pendingLocalTrack = track;
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(evaluateLocal, 350);
  }

  // Guests let the host's app pick the next song when one ends, so everyone moves on together.
  function holdAutoplay() {
    return !!(room && room.ready && !room.isHost);
  }

  function leave(silent) {
    if (!room) return;
    const wasHost = room.isHost;
    teardown();
    if (!silent) toast(wasHost ? 'Room closed' : 'Left the room', 'info');
  }

  // ---------- UI ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setOpen(open) {
    if (!ui) return;
    if (open) {
      const upnext = document.getElementById('ob-upnext');
      if (upnext && upnext.classList.contains('open')) document.getElementById('ob-upnext-close')?.click();
    }
    ui.panel.classList.toggle('open', open);
    ui.panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    ui.btn.classList.toggle('active', open);
    ui.btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderUI();
  }

  function renderUI(mode) {
    if (!ui) return;
    const inRoom = !!(room && room.ready);
    const connecting = mode === 'connecting' || (room && !room.ready);
    const count = inRoom ? memberList().length : 0;
    ui.count.hidden = !inRoom;
    ui.count.textContent = String(count);
    ui.btn.classList.toggle('lt-live', inRoom);
    ui.btn.title = inRoom ? `Listen Together: room ${room.code} (${count} listening)` : 'Listen Together';
    if (!ui.panel.classList.contains('open') && !connecting) return;

    let html = '';
    if (connecting) {
      html = `<div class="ob-lt-status"><span class="ob-lt-spinner"></span><span>${room && !room.isHost ? 'Joining room' : 'Opening a room'}…</span>
          <button type="button" class="ob-lt-link" data-lt="cancel">Cancel</button></div>`;
    } else if (!inRoom) {
      html = `<p class="ob-lt-lead">Hear the same song at the same moment as your friends. Anyone in the room can change it, pause or skip ahead.</p>
        <div class="ob-lt-field">
          <label class="ob-un-label ob-lt-label" for="ob-lt-name">Your name</label>
          <input class="ob-lt-input" id="ob-lt-name" maxlength="24" value="${esc(getName())}" spellcheck="false" autocomplete="off">
        </div>
        <button type="button" class="ob-lt-btn primary" data-lt="host">Start a room</button>
        <div class="ob-lt-field ob-lt-sep">
          <label class="ob-un-label ob-lt-label" for="ob-lt-code">Have a code?</label>
          <div class="ob-lt-join">
            <input class="ob-lt-input ob-lt-code-input" id="ob-lt-code" maxlength="7" placeholder="XXXXXX" spellcheck="false" autocomplete="off">
            <button type="button" class="ob-lt-btn" data-lt="join">Join</button>
          </div>
        </div>
        <p class="ob-lt-note">Each app streams the song itself. Local files stay on your device.</p>`;
    } else {
      const s = room.state;
      const members = memberList();
      const t = s && s.track;
      const art = t && [t.thumbnail, t.cover].find((u) => typeof u === 'string' && /^https:\/\//i.test(u));
      const picker = t && s.by && s.by !== room.selfId ? `picked by ${esc(nameOf(s.by))}` : (t ? 'picked by you' : '');
      const nowRow = t
        ? `<div class="ob-un-now ob-lt-now${s.playing ? ' is-playing' : ''}">
            <div class="ob-un-now-art ob-lt-art">${art ? `<img src="${esc(art)}" alt="" draggable="false">` : ''}<span class="ob-un-eq"><i></i><i></i><i></i></span></div>
            <div class="ob-un-text">
              <span class="ob-un-kicker">${s.playing ? 'Playing' : 'Paused'} · ${picker}</span>
              <span class="ob-un-title">${esc(t.title || 'Unknown')}</span>
              <span class="ob-un-artist">${esc(t.artist || '')}</span>
            </div>
          </div>`
        : `<p class="ob-lt-lead ob-lt-empty">Nothing on yet. Play any song and everyone in the room hears it.</p>`;
      html = `${nowRow}
        <div class="ob-lt-code-row">
          <div class="ob-lt-code-text">
            <span class="ob-lt-code">${esc(room.code)}</span>
            <span class="ob-lt-hint">Friends join with this code</span>
          </div>
          <button type="button" class="ob-lt-icon" data-lt="copy" title="Copy code" aria-label="Copy room code">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
          </button>
        </div>
        <div class="ob-un-label ob-lt-label">Listening <span>${members.length}</span></div>
        <ul class="ob-lt-members">${members.map((m) => `<li${m.host ? ' class="is-host"' : ''}>
            <span class="ob-lt-avatar">${esc((m.name || '?').charAt(0).toUpperCase())}</span>
            <span class="ob-lt-mname">${esc(m.name)}${m.id === room.selfId ? '<em>you</em>' : ''}</span>
            ${m.host ? '<span class="ob-lt-role">host</span>' : ''}
          </li>`).join('')}</ul>
        <div class="ob-lt-foot"><button type="button" class="ob-lt-link danger" data-lt="leave">${room.isHost ? 'Close room' : 'Leave room'}</button></div>`;
    }
    ui.body.innerHTML = html;
  }

  function onPanelClick(e) {
    const b = e.target.closest('[data-lt]');
    if (!b) return;
    const act = b.dataset.lt;
    const nameEl = document.getElementById('ob-lt-name');
    if (nameEl) setName(nameEl.value);
    if (act === 'host') startRoom();
    else if (act === 'join') joinRoom(document.getElementById('ob-lt-code')?.value);
    else if (act === 'cancel') leave(true);
    else if (act === 'leave') leave(false);
    else if (act === 'copy' && room) {
      const done = () => {
        b.classList.add('copied');
        b.title = 'Copied';
        setTimeout(() => { b.classList.remove('copied'); b.title = 'Copy code'; }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(room.code).then(done, () => {});
    }
  }

  function initUI() {
    const btn = document.getElementById('btn-ob-together');
    const panel = document.getElementById('ob-lt');
    if (!btn || !panel) return;
    ui = { btn, panel, body: document.getElementById('ob-lt-body'), count: document.getElementById('ob-lt-count') };
    btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!panel.classList.contains('open')); });
    document.getElementById('ob-lt-close')?.addEventListener('click', () => setOpen(false));
    document.getElementById('btn-ob-upnext')?.addEventListener('click', () => setOpen(false));
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'ob-lt-code') joinRoom(e.target.value);
      else if (e.target.id === 'ob-lt-name') { setName(e.target.value); e.target.blur(); }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!panel.classList.contains('open')) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      setOpen(false);
    });
    renderUI();
  }

  function attach(adapter) {
    app = adapter;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI, { once: true });
    else initUI();
  }

  window.SoulleakLT = {
    attach,
    notify,
    holdAutoplay,
    leave,
    isActive: () => !!(room && room.ready),
  };
})();
