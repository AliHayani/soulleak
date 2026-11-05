// Rank emblems: seven insignias whose geometry grows with the rank (Rank 7 Spawn at the bottom, Rank 1 True Larper
// at the top). Each emblem is a stack of small SVG layers inside one <span class="ob-emblem">. Every moving part
// (aura, core, rings, crest, orbiting shards) is its own layer, so its animation is a GPU transform / opacity change
// of a whole element, never a repaint (soulleak.css "Rank emblems v2"). Locked ranks are a dark silhouette with a
// padlock, except True Larper, which keeps its colors (dimmed by its row) so the goal looks worth chasing.
(function () {
  'use strict';

  let seq = 0;
  const PREFIX = `re${Math.random().toString(36).slice(2, 6)}`;

  // Linear gradient top-left to bottom-right.
  const lin = (id, a, b) => `<linearGradient id="${id}" x1="0.15" y1="0" x2="0.7" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
  const rad = (id, a, b, op = 1) => `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${a}" stop-opacity="${op}"/><stop offset="1" stop-color="${b}" stop-opacity="0"/></radialGradient>`;
  const layer = (cls, body, defs = '') => `<svg class="em-l ${cls}" viewBox="0 0 64 64">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`;
  const diamond = (x, y, r) => `M${x} ${y - r}L${x + r * 0.62} ${y}L${x} ${y + r}L${x - r * 0.62} ${y}Z`;

  // Locked silhouettes swap every color for these.
  const DARK = { a: '#2a2834', b: '#121118', line: '#3a3746', core: '#2f2c3a', glow: 'transparent' };

  const DRAW = {
    // Rank 7: fractured slate rhombus, hollow core. Matte, no glow, never moves.
    spawn(u, c) {
      const g = `${u}a`;
      return layer('em-static', `
        <path d="M32 5 57 32 32 59 7 32Z" fill="url(#${g})"/>
        <path d="M32 5 57 32 32 59 7 32Z" fill="none" stroke="${c.line}" stroke-width="1.2" stroke-linejoin="round"/>
        <path d="M32 17 46 32 32 47 18 32Z" fill="#0c0d11"/>
        <path d="M32 5 35.5 17.5 30 24 35 31 29.5 38 33 47" fill="none" stroke="#0c0d11" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M45 18.5 41 23" stroke="#0c0d11" stroke-width="1.4"/>`,
        lin(g, c.a, c.b));
    },

    // Rank 6: brushed-steel twin-chevron compass with a crisp inner blade. Static.
    wanderer(u, c) {
      const g = `${u}a`, h = `${u}b`;
      return layer('em-static', `
        <path d="M9 27 32 7 55 27 47 31 32 18 17 31Z" fill="url(#${g})"/>
        <path d="M9 37 17 33 32 46 47 33 55 37 32 57Z" fill="url(#${g})"/>
        <path d="M9 27 32 7 55 27 M9 37 32 57 55 37" fill="none" stroke="${c.line}" stroke-width="1" stroke-linejoin="round"/>
        <path d="M3 32h8M53 32h8" stroke="${c.line}" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M32 13 36.5 32 32 51 27.5 32Z" fill="url(#${h})"/>
        <path d="M32 13 36.5 32 32 32Z" fill="#fff" opacity="${c.locked ? 0.08 : 0.55}"/>`,
        lin(g, c.a, c.b) + lin(h, c.locked ? DARK.core : '#ffffff', c.locked ? DARK.b : '#8a95a6'));
    },

    // Rank 5: gold crown-crest flanked by two audio-wave blades. The core gem breathes.
    'aux-owner'(u, c) {
      const g = `${u}a`, k = `${u}k`;
      return layer('em-static', `
        <path d="M18 19 22 6 28 13 32 3 36 13 42 6 46 19Z" fill="url(#${g})"/>
        <path d="M14 22 32 14 50 22 47 44 32 57 17 44Z" fill="url(#${g})" stroke="${c.line}" stroke-width="1" stroke-linejoin="round"/>
        <path d="M32 20 44 26 42 42 32 51 22 42 20 26Z" fill="rgba(0,0,0,0.3)"/>
        <path d="M5 29h3v9H5zM9.5 24h3v19h-3zM51.5 24h3v19h-3zM56 29h3v9h-3z" fill="url(#${g})"/>`,
        lin(g, c.a, c.b))
        + layer('em-core', `<path d="M32 24 39.5 33.5 32 45 24.5 33.5Z" fill="url(#${k})"/><path d="M32 24 39.5 33.5 32 33.5Z" fill="#fff" opacity="${c.locked ? 0 : 0.7}"/>`,
          lin(k, c.locked ? DARK.core : '#fff6cf', c.locked ? DARK.b : '#e9a21f'));
    },

    // Rank 4: interlocking fortress sigil between two ward pillars, emerald / cyan edge cuts. The gate breathes.
    gatekeeper(u, c) {
      const g = `${u}a`, p = `${u}p`, k = `${u}k`;
      return layer('em-static', `
        <path d="M5 17h7v39H5zM52 17h7v39h-7z" fill="url(#${p})"/>
        <path d="M4 15h9l-4.5-8zM51 15h9l-4.5-8z" fill="url(#${p})"/>
        <path d="M19 11h26l7 9v22L32 58 12 42V20Z" fill="url(#${g})" stroke="${c.line}" stroke-width="1.4" stroke-linejoin="round"/>
        <path d="M19 11l5.5 8h15l5.5-8M12 20l8 5M52 20l-8 5" fill="none" stroke="${c.line}" stroke-width="1.1" opacity="0.85"/>
        <path d="M23 27h18M32 21v6" stroke="${c.line}" stroke-width="1.2" opacity="0.7"/>`,
        lin(g, c.locked ? DARK.a : '#123a33', c.locked ? DARK.b : '#06110f') + lin(p, c.a, c.b))
        + layer('em-core', `<path d="M26 47V36a6 6 0 0 1 12 0v11Z" fill="url(#${k})"/><path d="M29 47V37a3 3 0 0 1 6 0v10Z" fill="#04110d" opacity="${c.locked ? 0 : 0.55}"/>`,
          lin(k, c.locked ? DARK.core : '#9dffe6', c.locked ? DARK.b : '#0ea47e'));
    },

    // Rank 3: winged obsidian valkyrie with razor feather shards and a sapphire core that floats.
    scrobbler(u, c) {
      const w = `${u}w`, b = `${u}b`, k = `${u}k`, r = `${u}r`;
      return layer('em-static', `
        <path d="M25 26 3 13 9 21 1 24 11 30 3 35 15 36 22 41Z" fill="url(#${w})" stroke="${c.line}" stroke-width="0.9" stroke-linejoin="round"/>
        <path d="M39 26 61 13 55 21 63 24 53 30 61 35 49 36 42 41Z" fill="url(#${w})" stroke="${c.line}" stroke-width="0.9" stroke-linejoin="round"/>
        <path d="M28 10 32 2 36 10Z" fill="url(#${b})"/>
        <path d="M32 8 42 20 40 44 32 57 24 44 22 20Z" fill="url(#${b})" stroke="${c.line}" stroke-width="1.2" stroke-linejoin="round"/>
        ${c.locked ? '' : `<circle cx="32" cy="32" r="10" fill="url(#${r})"/>`}`,
        lin(w, c.locked ? DARK.a : '#2c3458', c.locked ? DARK.b : '#090c1a') + lin(b, c.locked ? DARK.a : '#1f2748', c.locked ? DARK.b : '#080a16') + rad(r, '#5b7cff', '#5b7cff', 0.55))
        + layer('em-core', `<path d="M32 22 37.5 32 32 43 26.5 32Z" fill="url(#${k})"/><path d="M32 22 37.5 32 32 32Z" fill="#fff" opacity="${c.locked ? 0 : 0.75}"/>`,
          lin(k, c.locked ? DARK.core : '#d6e3ff', c.locked ? DARK.b : '#3a55f0'));
    },

    // Rank 2: void droplet inside a fractured halo that slowly turns, jagged lightning shards, a neon-purple core
    // and a pulsing violet aura.
    'soul-leaker'(u, c) {
      const d = `${u}d`, k = `${u}k`, a = `${u}a`;
      const aura = c.locked ? '' : layer('em-aura', `<circle cx="32" cy="34" r="30" fill="url(#${a})"/>`, rad(a, '#a855f7', '#7c3aed', 0.5));
      return aura
        + layer('em-ring', `
          <circle cx="32" cy="33" r="27.5" fill="none" stroke="${c.locked ? DARK.line : '#b77cff'}" stroke-width="1.8" stroke-dasharray="15 4 5 4 9 4" stroke-linecap="round"/>
          <path d="${diamond(32, 5, 2.2)} ${diamond(59.5, 33, 2.2)} ${diamond(4.5, 33, 2.2)}" fill="${c.locked ? DARK.line : '#e9d5ff'}"/>`)
        + layer('em-static', `
          <path d="M14 15 21 23 16.5 25 23 32M50 15 43 23 47.5 25 41 32" fill="none" stroke="${c.locked ? DARK.line : '#c084fc'}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
          <path d="M32 9C32 9 46.5 26 46.5 38A14.5 14.5 0 0 1 17.5 38C17.5 26 32 9 32 9Z" fill="url(#${d})" stroke="${c.locked ? DARK.line : '#c084fc'}" stroke-width="1.3"/>`,
          lin(d, c.locked ? DARK.a : '#30104f', c.locked ? DARK.b : '#0a0312'))
        + layer('em-core', `<path d="M32 25C32 25 39.5 34.5 39.5 39.5A7.5 7.5 0 0 1 24.5 39.5C24.5 34.5 32 25 32 25Z" fill="url(#${k})"/>`,
          lin(k, c.locked ? DARK.core : '#f0dcff', c.locked ? DARK.b : '#8b2cf5'));
    },

    // Rank 1: the sovereign crest. Two counter-rotating rune rings, orbiting micro-shards, an eclipse core and
    // layered razor wings under floating crown spikes, all levitating together. Electric Violet, Neon Magenta, ice white.
    'true-larper'(u) {
      const a = `${u}a`, o = `${u}o`, w = `${u}w`, w2 = `${u}x`, b = `${u}b`, cr = `${u}c`;
      return layer('em-aura', `<circle cx="32" cy="32" r="31" fill="url(#${a})"/>`, rad(a, '#a855f7', '#ec4899', 0.6))
        + layer('em-ring', `
          <circle cx="32" cy="32" r="29.5" fill="none" stroke="url(#${o})" stroke-width="1.5" stroke-dasharray="3 4.5"/>
          <path d="${diamond(32, 2.5, 2.6)} ${diamond(61.5, 32, 2.6)} ${diamond(32, 61.5, 2.6)} ${diamond(2.5, 32, 2.6)}" fill="#f5e9ff"/>`,
          lin(o, '#7c3aed', '#ec4899'))
        + layer('em-ring2', `
          <circle cx="32" cy="32" r="23" fill="none" stroke="#e0f2fe" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="17 5"/>
          <path d="M32 7.5 34 11h-4zM53.2 44.5l-3.9-.3 2-3.4zM10.8 44.5l1.9-3.7 2 3.4z" fill="#f0abfc"/>`)
        + layer('em-orbit', `<path d="${diamond(32, 6.5, 1.8)} ${diamond(54.5, 45, 1.6)} ${diamond(9.5, 45, 1.6)}" fill="#ffffff"/>`)
        + layer('em-crest', `
          <path d="M24 30 2 17 8 27 0 31 10 35 4 41 21 39Z M40 30 62 17 56 27 64 31 54 35 60 41 43 39Z" fill="url(#${w})"/>
          <path d="M25 33 9 25 14 31 8 34 22 37Z M39 33 55 25 50 31 56 34 42 37Z" fill="url(#${w2})"/>
          <path d="M23.5 15 26.5 4.5 29.5 12 32 1.5 34.5 12 37.5 4.5 40.5 15Z" fill="url(#${cr})"/>
          <path d="M32 12 42.5 22 40.5 42 32 55 23.5 42 21.5 22Z" fill="url(#${b})" stroke="#e0f2fe" stroke-width="1.1" stroke-linejoin="round"/>
          <circle cx="32" cy="32" r="7.6" fill="#ec4899"/>
          <circle cx="32" cy="32" r="6.6" fill="#f5f3ff"/>
          <circle cx="34.6" cy="30.6" r="6.1" fill="#12051f"/>`,
          lin(w, '#6d28d9', '#1e0838') + lin(w2, '#f0abfc', '#9d174d') + lin(cr, '#ffffff', '#c4b5fd') + lin(b, '#8b5cf6', '#2e0a57'));
    },
  };

  // Unlocked colors of the static parts; locked ones use DARK.
  const COLORS = {
    spawn: { a: '#6b7280', b: '#2a2f38', line: '#8b93a2' },
    wanderer: { a: '#eef2f7', b: '#6b7585', line: '#c9d1dc' },
    'aux-owner': { a: '#ffe28a', b: '#b8741c', line: '#fff0b8' },
    gatekeeper: { a: '#5ff0cc', b: '#0b6f63', line: '#38e8c0' },
    scrobbler: { a: '#2c3458', b: '#090c1a', line: '#8fb0ff' },
    'soul-leaker': { a: '#30104f', b: '#0a0312', line: '#c084fc' },
    'true-larper': { a: '#8b5cf6', b: '#2e0a57', line: '#e0f2fe' },
  };

  const LOCK = '<svg class="em-l em-lock" viewBox="0 0 64 64"><circle cx="32" cy="35" r="11" fill="#0b0a10" opacity="0.85"/><path d="M28 34v-3a4 4 0 0 1 8 0v3" fill="none" stroke="#8c86a0" stroke-width="2.4"/><rect x="25.5" y="33.5" width="13" height="9.5" rx="2" fill="#8c86a0"/></svg>';

  function emblem(id, locked) {
    const draw = DRAW[id] || DRAW.spawn;
    const u = `${PREFIX}${++seq}`;
    // True Larper keeps its full colors even when locked; its row dims it and shows the lock.
    const darken = locked && id !== 'true-larper';
    const c = darken ? Object.assign({ locked: true }, DARK) : Object.assign({ locked: false }, COLORS[id] || COLORS.spawn);
    return `<span class="ob-emblem${locked ? ' is-locked' : ''}" data-rank="${id}">${draw(u, c)}${locked ? LOCK : ''}</span>`;
  }

  window.SoulleakRankEmblems = { emblem };
})();
