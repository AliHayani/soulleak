// Rank 1 "Ascension": the full-screen ceremony shown once, the moment a listener reaches True Larper (50 h).
// app.js attaches an adapter (stats, emblem, name) and calls check() whenever the rank card refreshes.
//  - Shown once per account: the flag lives in localStorage ('soulleak_true_larper_ceremony'), so .rfacc exports
//    carry it like every other setting.
//  - Replay: the "Replay Ascension" button on the True Larper row (Settings > Badges), or Ctrl+Shift+L anywhere.
//  - Everything that moves is transform/opacity (or one canvas), so it stays smooth on the GPU.
(function () {
  'use strict';

  const KEY = 'soulleak_true_larper_ceremony';
  const QUOTE = 'Congratulations on reaching the pinnacle. Keep larping — music is what feeds our Soul.';
  let app = null;
  let open = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function record() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  function markShown() {
    const r = record();
    if (r && r.shown) return r;
    const rec = { shown: true, at: Date.now() };
    try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch (_) {}
    return rec;
  }
  function unlockDate() {
    const r = record();
    const d = new Date(r && r.at ? r.at : Date.now());
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }
  // The sidebar rank card keeps a soft violet crown and aura once the ceremony has been seen.
  function syncAura() {
    const card = document.getElementById('ob-level');
    const r = record();
    if (card) card.classList.toggle('sl-ascended', !!(r && r.shown && card.dataset.rank === 'true-larper'));
  }

  // ---------- sound: a 5.5 s trophy fanfare, synthesized (no files), timed to the ceremony ----------
  // Stage 1 (0-0.9 s) sub-bass drop + rising noise swell as the screen shakes; stage 2 (0.45-1.65 s) four slow bell
  // chimes C-E-G-C as the crest lands; stage 3 (1.8-3.4 s) a wide C-major chord swell under the title; stage 4
  // (3.4-5.5 s) a few high sparkle pings ringing out. Everything runs through a generated 3.5 s cathedral reverb
  // (45% wet / 55% dry) and a compressor. The music ducks to 25% while it plays (app.duck).
  function playFanfare() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try { ctx = new AC(); } catch (_) { return; }
    if (app && app.duck) { try { app.duck(); } catch (_) {} }
    const now = ctx.currentTime + 0.04;
    const sr = ctx.sampleRate;

    const out = ctx.createGain(); out.gain.value = 0.5;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.006; comp.release.value = 0.35;
    comp.connect(out).connect(ctx.destination);
    // cathedral reverb: 3.5 s of stereo noise, decaying exponentially and darkening as it fades
    const len = Math.floor(sr * 3.5);
    const ir = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const k = i / len;
        const a = 0.55 - 0.45 * k; // one-pole low-pass that closes over time
        lp += a * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * Math.exp(-4.6 * k) * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
      }
    }
    const verb = ctx.createConvolver(); verb.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.45;
    const dry = ctx.createGain(); dry.gain.value = 0.55;
    const bus = ctx.createGain();
    bus.connect(dry).connect(comp);
    bus.connect(verb); verb.connect(wet).connect(comp);
    const panned = (pan) => { const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(bus); return p; };

    // Stage 1: sub-bass drop 110 -> 38 Hz over 0.45 s with a warm 1.2 s decay
    const sub = ctx.createOscillator(); sub.type = 'sine';
    sub.frequency.setValueAtTime(110, now); sub.frequency.exponentialRampToValueAtTime(38, now + 0.45);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.0001, now); subG.gain.exponentialRampToValueAtTime(0.95, now + 0.03); subG.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
    sub.connect(subG).connect(dry); // the sub stays dry so it stays tight
    sub.start(now); sub.stop(now + 1.3);
    // ...and a low-pass noise swell sweeping up 120 -> 1800 Hz
    const nb = ctx.createBuffer(2, sr * 1, sr);
    for (let ch = 0; ch < 2; ch++) { const d = nb.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const noise = ctx.createBufferSource(); noise.buffer = nb;
    const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.Q.value = 3;
    lpf.frequency.setValueAtTime(120, now); lpf.frequency.exponentialRampToValueAtTime(1800, now + 0.8);
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.0001, now); nG.gain.exponentialRampToValueAtTime(0.32, now + 0.55); nG.gain.exponentialRampToValueAtTime(0.0001, now + 0.95);
    noise.connect(lpf).connect(nG).connect(bus); noise.start(now); noise.stop(now + 1);

    // a bell: a few inharmonic partials with a quick strike and a long ring
    function bell(t, f, vel, pan, ring = 2.8) {
      const dest = panned(pan);
      [[1, 1, 1], [2.0, 0.55, 0.7], [2.76, 0.36, 0.5], [5.4, 0.2, 0.32], [8.93, 0.09, 0.2]].forEach(([ratio, amp, life]) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * ratio;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel * amp, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + ring * life);
        o.connect(g).connect(dest); o.start(t); o.stop(t + ring * life + 0.05);
      });
    }
    // Stage 2: four deliberate chimes, C6 E6 G6 C7, 0.4 s apart, left/right
    [[0.45, 1046.5, -0.35], [0.85, 1318.5, 0.35], [1.25, 1568, -0.2], [1.65, 2093, 0.2]].forEach(([at, f, pan], i) => bell(now + at, f, 0.16 + i * 0.02, pan, i === 3 ? 3.6 : 2.6));

    // Stage 3: the chord swell (C major, wide): detuned saws through a slowly opening low-pass
    const padF = ctx.createBiquadFilter(); padF.type = 'lowpass'; padF.Q.value = 0.8;
    padF.frequency.setValueAtTime(300, now + 1.8); padF.frequency.exponentialRampToValueAtTime(3600, now + 3.0); padF.frequency.exponentialRampToValueAtTime(1400, now + 5.4);
    const padG = ctx.createGain();
    padG.gain.setValueAtTime(0.0001, now + 1.8); padG.gain.exponentialRampToValueAtTime(0.13, now + 2.45); padG.gain.setValueAtTime(0.13, now + 3.4); padG.gain.exponentialRampToValueAtTime(0.0001, now + 5.5);
    padF.connect(padG).connect(bus);
    [130.81, 196.0, 261.63, 329.63, 392.0, 523.25].forEach((f, i) => {
      [-9, 9].forEach((cents, j) => {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = cents;
        const p = ctx.createStereoPanner(); p.pan.value = (j ? 0.45 : -0.45) * (i % 2 ? 1 : 0.6);
        const g = ctx.createGain(); g.gain.value = 1 / (1 + i * 0.25);
        o.connect(g).connect(p).connect(padF); o.start(now + 1.8); o.stop(now + 5.55);
      });
    });
    const low = ctx.createOscillator(); low.type = 'sine'; low.frequency.value = 65.41;
    const lowG = ctx.createGain(); lowG.gain.setValueAtTime(0.0001, now + 1.8); lowG.gain.exponentialRampToValueAtTime(0.28, now + 2.3); lowG.gain.exponentialRampToValueAtTime(0.0001, now + 5.3);
    low.connect(lowG).connect(dry); low.start(now + 1.8); low.stop(now + 5.4);
    bell(now + 1.85, 523.25, 0.12, 0, 3.4); // a lower bell on the chord's arrival

    // Stage 4: sparkle pings, softer and softer, into the reverb tail
    [[3.4, 4186, 0.07, 0.6], [3.7, 3136, 0.06, -0.6], [3.95, 5274, 0.05, 0.4], [4.3, 4186, 0.04, -0.3], [4.7, 6272, 0.03, 0.5]].forEach(([at, f, v, pan]) => bell(now + at, f, v, pan, 1.6));

    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 9500);
  }

  // ---------- embers: a light canvas particle fountain ----------
  function startEmbers(canvas, originEl) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ctx = canvas.getContext('2d');
    const resize = () => { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; };
    resize();
    // pre-rendered glow sprites (no per-frame shadow blur)
    const sprite = (color) => { const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d'); const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, '#fff'); gr.addColorStop(0.25, color); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 32, 32); return c; };
    const sprites = [sprite('#8b5cf6'), sprite('#a78bfa'), sprite('#ec4899'), sprite('#f43f5e'), sprite('#e0f2fe')];
    const parts = [];
    const start = performance.now();
    let raf = 0, last = start;
    const origin = () => { const r = originEl.getBoundingClientRect(); return { x: (r.left + r.width / 2) * dpr, y: (r.top + r.height * 0.6) * dpr }; };
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const age = (now - start) / 1000;
      // the fountain runs hardest as the crest lands, then keeps a gentle trickle
      const rate = age < 0.6 ? 0 : age < 2.2 ? 140 : age < 6 ? 30 : age < 8 ? 12 : 0;
      const o = origin();
      let n = rate ? rate * dt + Math.random() : 0;
      while (n-- >= 1 && parts.length < 260) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.5;
        const sp = (120 + Math.random() * 260) * dpr;
        parts.push({ x: o.x + (Math.random() - 0.5) * 60 * dpr, y: o.y, vx: Math.cos(a) * sp * 0.5, vy: Math.sin(a) * sp, life: 0, max: 1.6 + Math.random() * 2.2, s: (6 + Math.random() * 14) * dpr, img: sprites[(Math.random() * sprites.length) | 0], wob: Math.random() * 6 });
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life += dt;
        if (p.life > p.max) { parts.splice(i, 1); continue; }
        p.vy += -18 * dpr * dt; // embers keep drifting up
        p.vx *= 0.985; p.vy *= 0.985;
        p.x += (p.vx + Math.sin(p.life * 3 + p.wob) * 22 * dpr) * dt; p.y += p.vy * dt;
        const k = p.life / p.max;
        ctx.globalAlpha = (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85) * 0.9;
        const s = p.s * (1 - k * 0.5);
        ctx.drawImage(p.img, p.x - s / 2, p.y - s / 2, s, s);
      }
      ctx.globalAlpha = 1;
      // After 8 s the fountain stops; once the last ember fades the loop ends, even if the ceremony stays open.
      if (!rate && !parts.length) { raf = 0; return; }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    addEventListener('resize', resize);
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', resize); };
  }

  // ---------- the ceremony ----------
  function play(opts = {}) {
    if (open || !app) return;
    const preview = !!opts.preview;
    if (!preview) markShown();
    const st = app.stats();
    const name = app.name();
    const top = st.topArtists[0];
    const statLine = [
      `Unlocked ${esc(preview && !(record() || {}).shown ? new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : unlockDate())}`,
      `${st.songs.toLocaleString()} songs played`,
      top ? `Top artist: ${esc(top)}` : ''
    ].filter(Boolean).join('<i></i>');
    const el = document.createElement('div');
    el.className = 'sl-asc';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Rank 1 reached: True Larper');
    el.innerHTML = `
      <div class="sl-asc-shake">
        <canvas class="sl-asc-fx"></canvas>
        <div class="sl-asc-beam"></div><div class="sl-asc-ring"></div><div class="sl-asc-ring r2"></div>
        <div class="sl-asc-card">
          <div class="sl-asc-crest"><div class="sl-asc-halo"></div>${app.emblem('true-larper')}</div>
          <div class="sl-asc-pill">Apex tier reached <b>•</b> Rank 1 of 7</div>
          <h1 class="sl-asc-title">TRUE LARPER</h1>
          <blockquote class="sl-asc-quote">“${esc(QUOTE)}”</blockquote>
          <div class="sl-asc-stats">${statLine}</div>
          <div class="sl-asc-actions">
            <button type="button" class="sl-asc-btn primary" data-asc="keep">Keep Larping</button>
            <button type="button" class="sl-asc-btn" data-asc="flex">Save Flex Card</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    const stopEmbers = startEmbers(el.querySelector('.sl-asc-fx'), el.querySelector('.sl-asc-crest'));
    requestAnimationFrame(() => el.classList.add('is-in'));
    // the rune rings spin fast as the crest lands, then ease down to their normal orbit
    const spinT0 = performance.now();
    let spinRaf = 0;
    const spin = (now) => {
      const k = Math.min(1, (now - spinT0) / 1800);
      const rate = 1 + 22 * Math.pow(1 - k, 2.4);
      el.querySelectorAll('.sl-asc-crest .em-l').forEach((layer) => layer.getAnimations().forEach((a) => { a.playbackRate = rate; }));
      if (k < 1) spinRaf = requestAnimationFrame(spin);
    };
    setTimeout(() => { spinRaf = requestAnimationFrame(spin); }, 600);
    playFanfare();
    const close = () => {
      if (!open) return;
      open = null;
      cancelAnimationFrame(spinRaf);
      el.classList.add('is-out');
      setTimeout(() => { stopEmbers(); el.remove(); }, 650);
      document.removeEventListener('keydown', onKey, true);
      syncAura();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-asc]');
      if (!b) return;
      if (b.dataset.asc === 'keep') close();
      if (b.dataset.asc === 'flex') saveFlexCard(b, preview);
    });
    open = { el, close };
    setTimeout(() => el.querySelector('[data-asc="keep"]')?.focus(), 2600);
  }

  // ---------- flex card: the ascension as a 1600x900 PNG, copied to the clipboard and saved ----------
  async function svgLayersToImages(html) {
    const host = document.createElement('div'); host.innerHTML = html;
    return Promise.all([...host.querySelectorAll('svg')].map((svg) => new Promise((resolve) => {
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const img = new Image();
      img.onload = () => resolve(img); img.onerror = () => resolve(null);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.outerHTML);
    })));
  }
  async function saveFlexCard(btn, preview) {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Making your card…';
    try {
      const W = 1600, H = 900;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      // background: deep violet with a magenta glow
      g.fillStyle = '#07050d'; g.fillRect(0, 0, W, H);
      const glow = (x, y, r, col) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H); };
      glow(430, 450, 520, 'rgba(124,58,237,0.55)'); glow(1250, 160, 520, 'rgba(236,72,153,0.28)'); glow(1300, 820, 500, 'rgba(91,33,182,0.35)');
      // card border
      g.strokeStyle = 'rgba(196,181,253,0.35)'; g.lineWidth = 2; g.beginPath(); g.roundRect(40, 40, W - 80, H - 80, 36); g.stroke();
      // emblem (Soulleak's real True Larper layers)
      const layers = await svgLayersToImages(app.emblem('true-larper'));
      layers.forEach((img) => { if (img) g.drawImage(img, 150, 200, 500, 500); });
      const st = app.stats();
      const font = (w, s) => `${w} ${s}px "SF Pro Display", Inter, "Segoe UI Variable Display", "Segoe UI", sans-serif`;
      const x = 730;
      // pill
      g.font = font(700, 26); const pill = 'APEX TIER REACHED  •  RANK 1 OF 7'; const pw = g.measureText(pill).width + 56;
      g.fillStyle = 'rgba(139,92,246,0.18)'; g.strokeStyle = 'rgba(196,181,253,0.6)'; g.beginPath(); g.roundRect(x, 190, pw, 56, 28); g.fill(); g.stroke();
      g.fillStyle = '#e9d5ff'; g.fillText(pill, x + 28, 228);
      // title with the prismatic gradient
      g.font = font(900, 118); const tg = g.createLinearGradient(x, 0, x + 800, 0); tg.addColorStop(0, '#a78bfa'); tg.addColorStop(0.5, '#ec4899'); tg.addColorStop(1, '#ffffff');
      g.fillStyle = tg; g.fillText('TRUE LARPER', x - 6, 370);
      // who, when, how much
      g.fillStyle = '#ffffff'; g.font = font(700, 46); g.fillText(app.name(), x, 450);
      g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = font(500, 30);
      const when = preview && !(record() || {}).shown ? new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : unlockDate();
      g.fillText(`Unlocked ${when}  ·  ${Math.floor(st.totalSec / 3600)} h listened  ·  ${st.songs.toLocaleString()} songs`, x, 500);
      // top artists
      g.fillStyle = 'rgba(196,181,253,0.9)'; g.font = font(700, 24); g.fillText('TOP ARTISTS', x, 580);
      g.fillStyle = '#ffffff'; g.font = font(600, 34);
      (st.topArtists.slice(0, 3).length ? st.topArtists.slice(0, 3) : ['—']).forEach((a, i) => g.fillText(`${i + 1}.  ${a}`.slice(0, 40), x, 630 + i * 50));
      // footer: logo + wordmark
      const logo = await new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.onerror = () => r(null); im.src = '../../assets/soulleak-lilac.svg'; });
      if (logo) g.drawImage(logo, W - 300, H - 150, 64, 64);
      g.fillStyle = '#ffffff'; g.font = font(800, 40); g.fillText('Soulleak', W - 222, H - 104);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      let copied = false;
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); copied = true; } catch (_) {}
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'soulleak-true-larper.png'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      app.toast(copied ? 'Flex card copied. Paste it into Discord, or keep the saved PNG.' : 'Flex card saved as a PNG.', 'success');
      btn.textContent = copied ? 'Copied!' : 'Saved!';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
    } catch (e) {
      console.warn('[ascension] flex card failed', e);
      app.toast('Couldn’t make the flex card.', 'error');
      btn.textContent = orig; btn.disabled = false;
    }
  }

  // Called whenever the rank card refreshes: the first time True Larper is reached, the ceremony plays (if the
  // window is hidden, it waits until it's back so nobody misses it).
  function check(isTrueLarper) {
    syncAura();
    if (!isTrueLarper || open) return;
    const r = record();
    if (r && r.shown) return;
    if (document.hidden) {
      const once = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', once); check(true); } };
      document.addEventListener('visibilitychange', once);
      return;
    }
    play();
  }

  // Ctrl+Shift+L: replay the ceremony any time (a preview before Rank 1, so the real one still plays later).
  // Capture phase on window, so no other key handler in the app can swallow it first.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.code === 'KeyL' || e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || document.querySelector('.sl-asc')) return;
      const r = record();
      play({ preview: !(r && r.shown) });
    }
  }, true);

  window.SoulleakAscension = {
    attach(adapter) { app = adapter; syncAura(); },
    check,
    replay() { const r = record(); play({ preview: !(r && r.shown) }); },
    shown() { const r = record(); return !!(r && r.shown); }
  };
})();
