// Settings "ghost" live preview: while you change a visual setting, the Settings window fades away so you can see
// the app behind it.
//  - Dragging a slider: everything but that slider's row fades to 5% (the row floats as a pill) until you let go.
//  - Clicking a toggle, dropdown option or theme swatch: the whole window dips to 10% for 1.2 s.
//  - The eye button under ESC: hold it to see the app with Settings faded out.
// Only on the visual tabs (Banners, Theme, Custom themes, Interface) and never for non-visual Interface options.
(function () {
  'use strict';

  const VISUAL = new Set(['banners', 'theme', 'custom-themes', 'interface']);
  // Interface controls that don't change how the app looks.
  const NOT_VISUAL = new Set(['ui-lang-trigger', 'engine-api-trigger', 'btn-perf-mode', 'btn-no-hand-cursor']);
  const FLASH_MS = 1200;
  const CLEANUP_MS = 260;

  let tagged = [];
  let mode = '';
  let flashTimer = 0;
  let cleanupTimer = 0;
  let keyTimer = 0;

  const root = () => document.getElementById('view-settings');

  function visualControl(el) {
    if (!el || !el.closest) return false;
    const sec = el.closest('#view-settings .settings-section');
    if (!sec || !VISUAL.has(sec.dataset.cat)) return false;
    if (NOT_VISUAL.has(el.id)) return false;
    const dd = el.closest('.m3-dropdown');
    const trig = dd && dd.querySelector('.m3-dropdown-trigger');
    if (trig && NOT_VISUAL.has(trig.id)) return false;
    return true;
  }

  function tag(el, cls) {
    el.classList.add('sl-ghost-t', cls);
    tagged.push([el, cls]);
  }

  // keep: the element that stays fully visible (null = fade the whole window). op: how far everything else fades.
  function ghost(keep, op, kind) {
    const r = root();
    if (!r || !r.classList.contains('modal-open')) return;
    clearTimeout(cleanupTimer);
    tagged.forEach(([el, cls]) => el.classList.remove(cls));
    tagged = [];
    mode = kind;
    r.style.setProperty('--sl-ghost-op', String(op));
    r.classList.add('sl-ghost-tr', 'sl-ghost');
    if (!keep) {
      for (const c of r.children) tag(c, 'sl-ghost-dim');
      return;
    }
    tag(keep, 'sl-ghost-keep');
    let n = keep;
    while (n && n !== r) {
      const p = n.parentElement;
      if (!p) break;
      for (const c of p.children) if (c !== n) tag(c, 'sl-ghost-dim');
      if (p !== r) tag(p, 'sl-ghost-path');
      n = p;
    }
  }

  function release(kind) {
    if (kind && mode !== kind) return;
    const r = root();
    mode = '';
    clearTimeout(flashTimer);
    if (r) r.classList.remove('sl-ghost');
    tagged.forEach(([el, cls]) => el.classList.remove(cls));
    const done = tagged;
    tagged = [];
    // After the fade back, drop the transition helpers so the window's own open/close animation is untouched.
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      done.forEach(([el]) => el.classList.remove('sl-ghost-t'));
      if (r && !r.classList.contains('sl-ghost')) r.classList.remove('sl-ghost-tr');
    }, CLEANUP_MS);
  }

  function flash() {
    if (mode === 'drag' || mode === 'hold') return;
    ghost(null, 0.1, 'flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => release('flash'), FLASH_MS);
  }

  // ---- sliders ----
  document.addEventListener('pointerdown', (e) => {
    const range = e.target.closest && e.target.closest('input[type="range"]');
    if (!range || !visualControl(range)) return;
    ghost(range.closest('.setting-item') || range, 0.05, 'drag');
  }, true);
  const endDrag = () => { if (mode === 'drag') release('drag'); };
  document.addEventListener('pointerup', endDrag, true);
  document.addEventListener('pointercancel', endDrag, true);
  window.addEventListener('blur', endDrag);
  // Arrow keys on a focused slider: preview while the keys are being pressed.
  document.addEventListener('keydown', (e) => {
    const range = e.target.matches && e.target.matches('input[type="range"]') ? e.target : null;
    if (!range || !/^(Arrow|Page|Home|End)/.test(e.key) || !visualControl(range)) return;
    if (mode !== 'drag') ghost(range.closest('.setting-item') || range, 0.05, 'key');
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => release('key'), 700);
  }, true);

  // ---- toggles, dropdown options, theme swatches and presets ----
  // (App icon choices don't change the window, so they don't fade it.)
  const PEEK_CLICK = '.effect-switch-btn, .m3-dropdown-option, .theme-mode-btn, .theme-swatch, .preset-chip';
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest(PEEK_CLICK);
    if (!b || !visualControl(b)) return;
    // Let the change apply first, then fade.
    requestAnimationFrame(flash);
  }, true);

  // ---- "Hold to preview" eye ----
  function addEye() {
    const view = document.querySelector('#view-settings .settings-view');
    if (!view || document.getElementById('btn-sl-peek')) return;
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.id = 'btn-sl-peek';
    eye.className = 'sl-peek-btn';
    eye.title = 'Hold to preview';
    eye.setAttribute('aria-label', 'Hold to preview the app');
    eye.innerHTML = '<span class="sl-peek-circle"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></span><span class="sl-peek-label">PEEK</span>';
    eye.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { eye.setPointerCapture(e.pointerId); } catch (_) {}
      ghost(eye, 0.05, 'hold');
    });
    const up = () => release('hold');
    eye.addEventListener('pointerup', up);
    eye.addEventListener('pointercancel', up);
    eye.addEventListener('lostpointercapture', up);
    eye.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && mode !== 'hold') ghost(eye, 0.05, 'hold'); });
    eye.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') up(); });
    view.appendChild(eye);
    syncEye();
    const nav = document.getElementById('settings-nav');
    if (nav) new MutationObserver(syncEye).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  function syncEye() {
    const eye = document.getElementById('btn-sl-peek');
    if (!eye) return;
    const active = document.querySelector('#settings-nav .settings-nav-btn.active');
    eye.hidden = !(active && VISUAL.has(active.dataset.cat));
  }

  // Closing Settings mid-preview never leaves it faded.
  function watchClose() {
    const r = root();
    if (!r) return;
    new MutationObserver(() => { if (!r.classList.contains('modal-open') && mode) release(); })
      .observe(r, { attributes: true, attributeFilter: ['class'] });
  }

  function init() { addEye(); watchClose(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
