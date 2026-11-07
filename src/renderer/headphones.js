// Headphone correction: pick your headphones and the AutoEq profile for them (measured response -> neutral target)
// runs at the end of the audio chain. The 1.3 MB database (autoeq-db.json) is only loaded when the search is used;
// the chosen profile is saved on its own, so startup never touches the database.
(function () {
  'use strict';
  const KEY_PROFILE = 'sl_hp_eq';
  const KEY_ON = 'sl_hp_eq_on';
  const KIND = { i: 'In-ear', o: 'Over-ear', e: 'Earbuds' };
  const HINT = 'Pick your headphones and Soulleak tunes the sound to them';

  let db = null;
  let dbLoading = null;

  const read = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const compact = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function savedProfile() {
    try {
      const p = JSON.parse(read(KEY_PROFILE) || 'null');
      return p && Array.isArray(p.filters) && p.filters.length ? p : null;
    } catch (_) { return null; }
  }
  const isOn = () => read(KEY_ON) === '1' && !!savedProfile();

  function apply() {
    const engine = window.audioEngine;
    if (engine && typeof engine.setHeadphoneEq === 'function') engine.setHeadphoneEq(isOn() ? savedProfile() : null);
  }

  function loadDb() {
    if (db) return Promise.resolve(db);
    if (!dbLoading) {
      dbLoading = fetch('autoeq-db.json')
        .then((r) => r.json())
        .then((j) => {
          db = (j.items || []).map(([name, kind, by, preamp, filters]) => ({ name, kind, by, preamp, filters, key: compact(name) }));
          return db;
        })
        .catch((e) => { dbLoading = null; throw e; });
    }
    return dbLoading;
  }

  function search(query) {
    const tokens = String(query).toLowerCase().split(/\s+/).map(compact).filter(Boolean);
    if (!tokens.length || !db) return [];
    const whole = tokens.join('');
    const hits = db.filter((h) => tokens.every((t) => h.key.includes(t)));
    hits.sort((a, b) => (b.key.startsWith(whole) - a.key.startsWith(whole)) || (a.name.length - b.name.length) || a.name.localeCompare(b.name));
    return hits.slice(0, 8);
  }

  function init() {
    const card = document.getElementById('hp-eq-card');
    if (!card) return;
    const toggle = document.getElementById('toggle-hp-eq');
    const current = document.getElementById('hp-eq-current');
    const input = document.getElementById('hp-eq-search');
    const results = document.getElementById('hp-eq-results');
    let shown = [];

    function render() {
      const p = savedProfile();
      const on = isOn();
      toggle.classList.toggle('active', on);
      card.classList.toggle('is-on', on);
      current.textContent = p ? `${p.name} · ${KIND[p.kind] || 'Headphones'}${on ? '' : ' · off'}` : HINT;
    }

    function showResults(list, note) {
      shown = list;
      if (note) { results.innerHTML = `<div class="hp-eq-note">${esc(note)}</div>`; results.hidden = false; return; }
      if (!list.length) { results.innerHTML = ''; results.hidden = true; return; }
      results.innerHTML = list.map((h, i) => `<button type="button" class="hp-eq-opt" data-i="${i}" role="option">
          <span class="hp-eq-opt-name">${esc(h.name)}</span><span class="hp-eq-opt-kind">${KIND[h.kind] || ''}</span></button>`).join('');
      results.hidden = false;
    }

    function choose(h) {
      write(KEY_PROFILE, JSON.stringify({ name: h.name, kind: h.kind, by: h.by, preamp: h.preamp, filters: h.filters }));
      write(KEY_ON, '1');
      input.value = '';
      showResults([]);
      input.blur();
      render();
      apply();
    }

    let seq = 0;
    async function onInput() {
      const q = input.value.trim();
      const my = ++seq;
      if (!q) { showResults([]); return; }
      try { await loadDb(); } catch (_) { showResults([], 'Could not load the headphone list'); return; }
      if (my !== seq) return;
      const list = search(q);
      showResults(list, list.length ? '' : 'No match. Try just the model, like "XM4" or "Quest 3"');
    }

    input.addEventListener('focus', () => { loadDb().catch(() => {}); if (input.value.trim()) onInput(); });
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && shown[0]) { e.preventDefault(); choose(shown[0]); }
      if (e.key === 'Escape') { input.value = ''; showResults([]); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) showResults([]); }, 150));
    results.addEventListener('mousedown', (e) => e.preventDefault());
    results.addEventListener('click', (e) => {
      const b = e.target.closest('.hp-eq-opt');
      if (b && shown[+b.dataset.i]) choose(shown[+b.dataset.i]);
    });
    toggle.addEventListener('click', () => {
      if (!savedProfile()) { input.focus(); return; }
      write(KEY_ON, isOn() ? '0' : '1');
      render();
      apply();
    });

    render();
    // app.js creates window.audioEngine during its startup; hand it the saved profile as soon as it exists.
    let tries = 0;
    (function waitForEngine() {
      if (window.audioEngine && typeof window.audioEngine.setHeadphoneEq === 'function') { apply(); return; }
      if (++tries < 200) setTimeout(waitForEngine, 100);
    })();
  }

  window.SoulleakHeadphones = { apply, search: (q) => loadDb().then(() => search(q)) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
