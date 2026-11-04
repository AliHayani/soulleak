// Soulleak shell: the header tabs, the header Settings button and the library "+" are stand-ins for buttons that
// still live (hidden) in the sidebar. Clicking one clicks the original, so every existing listener in app.js keeps
// doing the work, and each tab copies its original's "active" state so it lights up for the current view.
(function () {
  'use strict';

  function wire() {
    const proxies = Array.from(document.querySelectorAll('[data-sl-proxy]'));
    proxies.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = document.getElementById(btn.dataset.slProxy);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        target.click();
      });
    });

    const tabs = proxies.filter((b) => b.classList.contains('sl-tab'));
    const sync = () => {
      tabs.forEach((tab) => {
        const target = document.getElementById(tab.dataset.slProxy);
        const on = !!(target && target.classList.contains('active'));
        tab.classList.toggle('active', on);
        if (on) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
      });
    };
    const observer = new MutationObserver(sync);
    tabs.forEach((tab) => {
      const target = document.getElementById(tab.dataset.slProxy);
      if (target) observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    });
    sync();
  }

  // Home rows (For you, Jump back in, History, artists): grab and drag sideways with the mouse. A press that
  // moves less than a few pixels is still a normal click; a real drag swallows the click it ends with.
  const ROWS = '#sp-home .sp-row, #sp-home #sp-quick';
  const DRAG_PX = 6;
  function wireDragScroll() {
    let drag = null;
    document.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      const row = e.target.closest(ROWS);
      if (!row || row.scrollWidth <= row.clientWidth + 2) return;
      drag = { row, x: e.clientX, left: row.scrollLeft, moved: false, id: e.pointerId };
    });
    document.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < DRAG_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        drag.row.classList.add('sl-dragging');
        try { drag.row.setPointerCapture(e.pointerId); } catch (_) {}
      }
      drag.row.scrollLeft = drag.left - dx;
      e.preventDefault();
    });
    const end = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const { row, moved } = drag;
      drag = null;
      row.classList.remove('sl-dragging');
      if (moved) {
        // Eat the click that the browser fires at the end of the drag, so no card opens by accident.
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, true), 50);
      }
    };
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
    // Images inside the cards would otherwise start a native image drag instead.
    document.addEventListener('dragstart', (e) => { if (e.target.closest && e.target.closest(ROWS)) e.preventDefault(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { wire(); wireDragScroll(); }, { once: true });
  else { wire(); wireDragScroll(); }
})();
