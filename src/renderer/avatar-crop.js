// Avatar crop: after you pick a photo, drag it into place inside the circle and zoom with the slider (or the mouse
// wheel). Saving renders the visible square to a 512x512 JPEG data URL, which becomes the avatar.
// SoulleakCrop.open(url) resolves with that data URL, or null if you cancel.
(function () {
  'use strict';

  const OUT = 512;
  const STAGE = 300;

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load that image'));
      img.src = url;
    });
  }

  function open(url) {
    return new Promise(async (resolve) => {
      let img;
      try { img = await loadImage(url); } catch (_) { resolve(null); return; }

      // Scale so the image covers the circle at minimum zoom; zoom goes up to 4x that.
      const base = Math.max(STAGE / img.naturalWidth, STAGE / img.naturalHeight);
      let zoom = 1;
      let x = 0;
      let y = 0;

      const backdrop = el('div', 'slc-backdrop');
      const card = el('div', 'slc-card');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', 'Crop your profile picture');
      card.innerHTML = `
        <h3 class="slc-title">Crop your picture</h3>
        <p class="slc-sub">Drag to move it. Zoom to fit.</p>
        <div class="slc-stage"><canvas class="slc-canvas" width="${STAGE * 2}" height="${STAGE * 2}"></canvas><div class="slc-mask" aria-hidden="true"></div></div>
        <label class="slc-zoom"><span>Zoom</span><input type="range" min="1" max="4" step="0.01" value="1" aria-label="Zoom"></label>
        <div class="slc-actions">
          <button type="button" class="slc-btn ghost" data-slc="cancel">Cancel</button>
          <button type="button" class="slc-btn primary" data-slc="save">Save</button>
        </div>`;
      backdrop.appendChild(card);
      document.body.appendChild(backdrop);

      const canvas = card.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const range = card.querySelector('input[type=range]');

      const size = () => ({ w: img.naturalWidth * base * zoom, h: img.naturalHeight * base * zoom });
      // Keep the image covering the whole circle: no empty edges.
      const clamp = () => {
        const { w, h } = size();
        const maxX = Math.max(0, (w - STAGE) / 2);
        const maxY = Math.max(0, (h - STAGE) / 2);
        x = Math.min(maxX, Math.max(-maxX, x));
        y = Math.min(maxY, Math.max(-maxY, y));
      };
      const draw = () => {
        clamp();
        const { w, h } = size();
        const k = canvas.width / STAGE;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (STAGE / 2 - w / 2 + x) * k, (STAGE / 2 - h / 2 + y) * k, w * k, h * k);
      };
      draw();

      let drag = null;
      canvas.addEventListener('pointerdown', (e) => {
        drag = { px: e.clientX, py: e.clientY, x, y };
        canvas.setPointerCapture(e.pointerId);
        canvas.classList.add('is-dragging');
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!drag) return;
        x = drag.x + (e.clientX - drag.px);
        y = drag.y + (e.clientY - drag.py);
        draw();
      });
      const endDrag = () => { drag = null; canvas.classList.remove('is-dragging'); };
      canvas.addEventListener('pointerup', endDrag);
      canvas.addEventListener('pointercancel', endDrag);

      const setZoom = (z) => {
        const nz = Math.min(4, Math.max(1, z));
        // Zoom around the center of the circle.
        x *= nz / zoom;
        y *= nz / zoom;
        zoom = nz;
        range.value = String(nz);
        draw();
      };
      range.addEventListener('input', () => setZoom(parseFloat(range.value)));
      canvas.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); }, { passive: false });

      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.classList.add('is-leaving');
        setTimeout(() => backdrop.remove(), 160);
        resolve(result);
      };
      const save = () => {
        const out = document.createElement('canvas');
        out.width = OUT;
        out.height = OUT;
        const o = out.getContext('2d');
        const { w, h } = size();
        const k = OUT / STAGE;
        o.imageSmoothingQuality = 'high';
        o.fillStyle = '#000';
        o.fillRect(0, 0, OUT, OUT);
        o.drawImage(img, (STAGE / 2 - w / 2 + x) * k, (STAGE / 2 - h / 2 + y) * k, w * k, h * k);
        let data = null;
        try { data = out.toDataURL('image/jpeg', 0.9); } catch (_) { data = null; }
        close(data);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        else if (e.key === 'Enter') { e.stopPropagation(); save(); }
      };
      document.addEventListener('keydown', onKey, true);
      backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(null); });
      card.querySelector('[data-slc=cancel]').addEventListener('click', () => close(null));
      card.querySelector('[data-slc=save]').addEventListener('click', save);
      requestAnimationFrame(() => backdrop.classList.add('is-open'));
    });
  }

  window.SoulleakCrop = { open };
})();
