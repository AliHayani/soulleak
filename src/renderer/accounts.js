// Accounts: several Soulleak accounts on one computer, each with its own playlists, liked songs, history, rank XP
// and Soul Playback months, switchable in Settings > Account.
//
// The active account lives where it always has (localStorage + the 'soulleak-stats' and 'soulleak-playback'
// IndexedDB databases). Other accounts are parked in the 'soulleak-accounts' vault database. Switching saves the
// active account into the vault, writes the target's data in its place, and reloads the window.
//
// .rfacc files: importing one adds it as a new account (it no longer wipes the current one). Exports now carry the
// rank XP and Soul Playback data too (version 1.1); older files still import (they just start without those).
(function () {
  'use strict';

  const VAULT = ['soulleak-accounts', 'profiles', 'id'];
  const STATS = ['soulleak-stats', 'counters', 'key'];
  const PLAYBACK = ['soulleak-playback', 'months', 'month'];
  const ACTIVE_KEY = 'soulleak_active_account';
  const SHARED_KEYS = new Set([ACTIVE_KEY]);
  const MAIN_ID = 'acc_main';

  let app = null;
  let busy = false;

  // ---------- IndexedDB helpers ----------

  function open([name, store, keyPath]) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store, { keyPath });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function run(spec, mode, fn) {
    const db = await open(spec);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(spec[1], mode);
      let out;
      try { out = fn(tx.objectStore(spec[1])); } catch (e) { db.close(); reject(e); return; }
      tx.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : out); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error('aborted')); };
    });
  }

  const getAll = (spec) => run(spec, 'readonly', (s) => s.getAll());
  const getOne = (spec, key) => run(spec, 'readonly', (s) => s.get(key));
  const put = (spec, row) => run(spec, 'readwrite', (s) => { s.put(row); });
  const del = (spec, key) => run(spec, 'readwrite', (s) => { s.delete(key); });
  const replaceAll = (spec, rows) => run(spec, 'readwrite', (s) => {
    s.clear();
    (Array.isArray(rows) ? rows : []).forEach((r) => { if (r && r[spec[2]] != null) s.put(r); });
  });

  // ---------- account data ----------

  function lsDump() {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !SHARED_KEYS.has(k)) out[k] = localStorage.getItem(k);
    }
    return out;
  }

  function parseArr(v) {
    try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }

  function summarize(ls, stats) {
    const pls = parseArr(ls.devsize_playlists);
    const liked = parseArr(ls.devsize_favorites).length;
    const songs = pls.reduce((n, p) => n + ((p && Array.isArray(p.tracks)) ? p.tracks.length : 0), 0);
    const totalRow = (stats || []).find((r) => r && r.key === 'total');
    const seconds = totalRow ? totalRow.seconds : (parseInt(ls.soulleak_listen_seconds || '0', 10) || 0);
    return {
      playlists: pls.length,
      songs,
      liked,
      seconds,
      rank: app && app.rankName ? app.rankName(seconds) : '',
      nickname: ls.riff_user_nickname || '',
      avatar: ls.riff_user_avatar || '',
    };
  }

  function activeId() { return localStorage.getItem(ACTIVE_KEY) || MAIN_ID; }

  async function liveSnapshot() {
    if (app && app.flush) app.flush();
    // Let the flush transactions land before reading them back.
    await new Promise((r) => setTimeout(r, 200));
    const ls = lsDump();
    const [stats, playback] = await Promise.all([getAll(STATS).catch(() => []), getAll(PLAYBACK).catch(() => [])]);
    return { ls, stats, playback };
  }

  // The active account always has a vault record (its data there is refreshed on every switch away).
  async function ensureActiveRecord() {
    const id = activeId();
    let rec = await getOne(VAULT, id).catch(() => null);
    if (!rec) {
      const ls = lsDump();
      rec = { id, name: ls.riff_user_nickname && ls.riff_user_nickname !== 'User' ? ls.riff_user_nickname : 'Main account', createdAt: Date.now(), source: 'local' };
      await put(VAULT, rec);
      if (!localStorage.getItem(ACTIVE_KEY)) localStorage.setItem(ACTIVE_KEY, id);
    }
    return rec;
  }

  async function listAccounts() {
    const active = await ensureActiveRecord();
    const all = await getAll(VAULT).catch(() => []);
    const live = await liveSnapshot();
    return all
      .map((r) => (r.id === active.id ? Object.assign({}, r, { active: true, summary: summarize(live.ls, live.stats) }) : Object.assign({}, r, { active: false, summary: r.summary || summarize(r.ls || {}, r.stats || []) })))
      .sort((a, b) => (b.active - a.active) || ((a.createdAt || 0) - (b.createdAt || 0)));
  }

  // After the swap nothing may write the old account's values back (unload handlers, timers): localStorage writes
  // become no-ops and the stats / Soul Playback flushes are skipped (they check window.__slSwitching).
  function freezeStorage() {
    const ls = window.localStorage;
    const set = Storage.prototype.setItem;
    const rem = Storage.prototype.removeItem;
    const clr = Storage.prototype.clear;
    Storage.prototype.setItem = function (k, v) { if (this === ls) return; return set.call(this, k, v); };
    Storage.prototype.removeItem = function (k) { if (this === ls) return; return rem.call(this, k); };
    Storage.prototype.clear = function () { if (this === ls) return; return clr.call(this); };
  }

  async function switchTo(id) {
    if (busy) return;
    const fromId = activeId();
    if (id === fromId) return;
    busy = true;
    try {
      const target = await getOne(VAULT, id);
      if (!target) throw new Error('That account is missing.');
      if (app && app.beforeSwitch) app.beforeSwitch();

      // 1. Park the active account (with everything it has right now) in the vault.
      const snap = await liveSnapshot();
      window.__slSwitching = true;
      const fromRec = (await getOne(VAULT, fromId).catch(() => null)) || { id: fromId, name: 'Main account', createdAt: Date.now() };
      await put(VAULT, Object.assign({}, fromRec, { ls: snap.ls, stats: snap.stats, playback: snap.playback, summary: summarize(snap.ls, snap.stats), updatedAt: Date.now() }));

      // 2. Bring the target in.
      await replaceAll(STATS, target.stats || []);
      await replaceAll(PLAYBACK, target.playback || []);
      Object.keys(lsDump()).forEach((k) => localStorage.removeItem(k));
      Object.entries(target.ls || {}).forEach(([k, v]) => {
        if (SHARED_KEYS.has(k) || v == null) return;
        localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      });
      localStorage.setItem(ACTIVE_KEY, id);
      if (window.electronAPI && window.electronAPI.storageSaveSync && window.__RIFF_STORAGE_MAP__) {
        window.electronAPI.storageSaveSync(window.__RIFF_STORAGE_MAP__);
      }
      freezeStorage();
      // 3. Start fresh with the new account.
      location.reload();
    } catch (e) {
      window.__slSwitching = false;
      busy = false;
      console.warn('[Accounts] switch failed', e);
      toast(`Couldn't switch accounts: ${e.message || e}`, 'error');
    }
  }

  async function importAccount() {
    if (busy || !window.electronAPI || !window.electronAPI.accountImport) return;
    const res = await window.electronAPI.accountImport();
    if (!res || res.canceled) return;
    if (!res.success || !res.data) { toast((res && res.error) || 'Could not read that account file', 'error'); return; }
    await addFromFile(res.data, res.filePath);
  }

  // Turns a decrypted .rfacc (version 1.0 or 1.1) into a new account in the vault.
  async function addFromFile(data, filePath) {
    const res = { filePath };
    const ls = (data.localStorage && typeof data.localStorage === 'object') ? data.localStorage : (typeof data === 'object' ? data : {});
    const idb = data.indexedDB || {};
    const fileName = String(res.filePath || '').split(/[\\/]/).pop().replace(/\.rfacc$/i, '') || 'Imported account';
    const strLs = {};
    Object.entries(ls).forEach(([k, v]) => { if (!SHARED_KEYS.has(k) && v != null) strLs[k] = typeof v === 'string' ? v : JSON.stringify(v); });
    const stats = Array.isArray(idb.stats) ? idb.stats : [];
    const playback = Array.isArray(idb.playback) ? idb.playback : [];
    const rec = {
      id: 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: fileName,
      createdAt: Date.now(),
      source: 'import',
      ls: strLs,
      stats,
      playback,
      summary: summarize(strLs, stats),
    };
    await ensureActiveRecord();
    await put(VAULT, rec);
    toast(`Added "${rec.name}". Switch to it any time.`, 'success');
    render();
  }

  async function exportActive() {
    if (busy || !window.electronAPI || !window.electronAPI.accountExport) return;
    const rec = await ensureActiveRecord();
    const snap = await liveSnapshot();
    const payload = {
      app: 'Soulleak',
      version: '1.1',
      exportedAt: Date.now(),
      localStorage: snap.ls,
      indexedDB: { stats: snap.stats, playback: snap.playback },
      suggestedName: rec.name || 'soulleak-account',
    };
    const res = await window.electronAPI.accountExport(payload);
    if (res && res.success) toast('Account exported', 'success');
    else if (res && !res.canceled) toast(res.error || 'Account export failed', 'error');
  }

  async function removeAccount(id) {
    if (busy || id === activeId()) return;
    const rec = await getOne(VAULT, id).catch(() => null);
    if (!rec) return;
    const ok = window.confirmChain
      ? await window.confirmChain({ title: 'Remove account', message: `"${rec.name}" and its playlists, history and ranks will be removed from this computer. Export it first if you want to keep a copy.`, confirmLabel: 'Remove', seconds: 2 })
      : window.confirm(`Remove "${rec.name}" from this computer?`);
    if (!ok) return;
    await del(VAULT, id);
    toast(`Removed "${rec.name}"`, 'info');
    render();
  }

  async function renameAccount(id, name) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return;
    const rec = await getOne(VAULT, id).catch(() => null);
    if (!rec || rec.name === clean) return;
    await put(VAULT, Object.assign({}, rec, { name: clean }));
  }

  // ---------- UI (Settings > Account) ----------

  function toast(msg, type) { if (app && app.toast) app.toast(msg, type); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

  async function render() {
    const list = document.getElementById('sl-acc-list');
    if (!list) return;
    let accounts = [];
    try { accounts = await listAccounts(); } catch (e) { list.innerHTML = `<p class="sl-acc-empty">Couldn't read your accounts.</p>`; return; }
    list.innerHTML = accounts.map((a) => {
      const s = a.summary || {};
      const avatar = typeof s.avatar === 'string' && /^(data:image\/|https?:|file:)/i.test(s.avatar) ? s.avatar : '../../assets/icon.png';
      const meta = [plural(s.playlists || 0, 'playlist', 'playlists'), plural(s.songs || 0, 'song', 'songs'), s.rank].filter(Boolean).join(' · ');
      return `<div class="sl-acc-row${a.active ? ' is-active' : ''}" data-id="${esc(a.id)}">
          <img class="sl-acc-avatar" src="${esc(avatar)}" alt="" draggable="false">
          <div class="sl-acc-text">
            <input class="sl-acc-name" value="${esc(a.name)}" maxlength="40" spellcheck="false" aria-label="Account name" title="Rename">
            <span class="sl-acc-meta">${esc(meta)}</span>
          </div>
          ${a.active
            ? '<span class="sl-acc-badge">Active</span>'
            : `<button type="button" class="sl-acc-btn ghost" data-acc="remove" title="Remove from this computer" aria-label="Remove account"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
               <button type="button" class="sl-acc-btn primary" data-acc="switch">Switch</button>`}
        </div>`;
    }).join('');
  }

  function wire() {
    const panel = document.getElementById('sl-accounts');
    if (!panel || panel._wired) return;
    panel._wired = true;
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-acc]');
      if (!b) return;
      const row = b.closest('.sl-acc-row');
      const act = b.dataset.acc;
      if (act === 'import') importAccount();
      else if (act === 'export') exportActive();
      else if (act === 'switch' && row) { b.textContent = 'Switching…'; b.disabled = true; switchTo(row.dataset.id); }
      else if (act === 'remove' && row) removeAccount(row.dataset.id);
    });
    panel.addEventListener('change', (e) => {
      if (!e.target.classList.contains('sl-acc-name')) return;
      const row = e.target.closest('.sl-acc-row');
      if (row) renameAccount(row.dataset.id, e.target.value);
    });
    panel.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('sl-acc-name')) e.target.blur(); });
    // Refresh the list whenever the Account page opens.
    const section = document.getElementById('settings-section-account');
    if (section) {
      new MutationObserver(() => { if (!section.classList.contains('cat-hidden')) render(); })
        .observe(section, { attributes: true, attributeFilter: ['class'] });
    }
    render();
  }

  function attach(adapter) {
    app = adapter;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
    else wire();
    ensureActiveRecord().catch(() => {});
  }

  window.SoulleakAccounts = { attach, switchTo, importAccount, addFromFile, exportActive, list: listAccounts, render };
})();
