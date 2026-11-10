
(function (global) {
  'use strict';

  class RiffAudioEngine {
    constructor() {
      this.ctx = null;
      this.mediaSource = null;
      this.graphInitialized = false;

      this.stdInput = null;
      this.dryGain = null;
      this.distortionNode = null;
      this.distortionGain = null;
      this.delayNode = null;
      this.delayFeedback = null;
      this.delayGain = null;
      this.convolverNode = null;
      this.reverbGain = null;

      this.hqInput = null;
      this.hqCompressor = null;
      this.hqBass = null;
      this.hqVocal = null;
      this.hqAir = null;
      this.hqSaturation = null;
      this.hqLimiter = null;

      this.eqLow = null;
      this.eqMid = null;
      this.eqHigh = null;
      this.eqBands = [];

      this.masterGain = null;
      this.analyserNode = null;
      this.normGain = null;
      this.normLimiter = null;
      this.levelAnalyser = null;
      this.levelBuf = null;
      this.fadeGain = null;
      this.bus = null;
      this._analyserConnected = false;
      this._suspendTimer = null;
      this._attachedElement = null;
      this._routingState = null;

      this.hqEnabled = false;
      this.hqSettings = {
        engine: 'hqmusic-3',
        preset: 'studio',
        vocal: 0,
        air: 0,
        bass: 0
      };
      this.audioSettings = {
        speed: 1.0,
        speedPitch: 1.0,
        pitch: 0,
        reverb: 0,
        distortion: 0,
        volume: 1.0,
        echo: 0,
        eq: { low: 0, mid: 0, high: 0 },
        eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      };
      this.isMuted = false;
      this.volume = 0.85;
    }


    _createReverbImpulse(ctx) {
      const rate = ctx.sampleRate;
      const len = Math.floor(rate * 0.6);
      const impulse = ctx.createBuffer(2, len, rate);
      const left = impulse.getChannelData(0);
      const right = impulse.getChannelData(1);
      for (let i = 0; i < len; i++) {
        const decay = Math.exp(-i / (rate * 0.15));
        left[i] = (Math.random() * 2 - 1) * decay;
        right[i] = (Math.random() * 2 - 1) * decay;
      }
      return impulse;
    }

    _makeDistortionCurve(amount = 0) {
      const n = 256;
      const curve = new Float32Array(n);
      const k = amount * 2.5;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        if (k <= 0) {
          curve[i] = x;
        } else {
          curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
        }
      }
      return curve;
    }

    _makeHarmonicCurve(amount = 0) {
      const n = 256;
      const curve = new Float32Array(n);
      const k = amount * 0.02;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = x - k * Math.pow(x, 3);
      }
      return curve;
    }


    init(audioElement) {
      if (!audioElement) return;

      if (this.ctx) {
        if (!audioElement.paused && this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
      } else {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'playback' });
      }

      if (this._attachedElement !== audioElement) {
        this._attachedElement = audioElement;
        audioElement.addEventListener('play', () => this.resumeAudioContext());
        audioElement.addEventListener('pause', () => this.suspendAudioContextDebounced(5000));
        audioElement.addEventListener('ended', () => this.suspendAudioContextDebounced(5000));
        // VHS Melt's tape hiss is only heard while a song plays.
        ['play', 'playing', 'pause', 'ended', 'emptied'].forEach((ev) => audioElement.addEventListener(ev, () => this._gateHiss()));
      }

      if (!this.graphInitialized) {
        try {
          this.mediaSource = this.ctx.createMediaElementSource(audioElement);

          this.stdInput = this.ctx.createGain();
          this.hqInput = this.ctx.createGain();

          this.hqCompressor = this.ctx.createDynamicsCompressor();

          this.hqBass = this.ctx.createBiquadFilter();
          this.hqBass.type = 'lowshelf';
          this.hqBass.frequency.value = 80;

          this.hqVocal = this.ctx.createBiquadFilter();
          this.hqVocal.type = 'peaking';
          this.hqVocal.frequency.value = 2500;
          this.hqVocal.Q.value = 1.2;

          this.hqAir = this.ctx.createBiquadFilter();
          this.hqAir.type = 'highshelf';
          this.hqAir.frequency.value = 9000;

          this.hqSaturation = this.ctx.createWaveShaper();
          this.hqSaturation.oversample = '2x';

          this.hqLimiter = this.ctx.createDynamicsCompressor();
          this.hqLimiter.threshold.value = -1;
          this.hqLimiter.knee.value = 0;
          this.hqLimiter.ratio.value = 20;
          this.hqLimiter.attack.value = 0.005;
          this.hqLimiter.release.value = 0.05;

          this.hqInput.connect(this.hqCompressor);
          this.hqCompressor.connect(this.hqBass);
          this.hqBass.connect(this.hqVocal);
          this.hqVocal.connect(this.hqAir);
          this.hqAir.connect(this.hqSaturation);
          this.hqSaturation.connect(this.hqLimiter);

          this.dryGain = this.ctx.createGain();
          this.dryGain.gain.value = 1.0;

          this.distortionNode = this.ctx.createWaveShaper();
          this.distortionNode.oversample = 'none';
          this.distortionNode.curve = this._makeDistortionCurve(0);
          this.distortionGain = this.ctx.createGain();
          this.distortionGain.gain.value = 0.0;

          this.delayNode = this.ctx.createDelay(1.0);
          this.delayNode.delayTime.value = 0.3;
          this.delayFeedback = this.ctx.createGain();
          this.delayFeedback.gain.value = 0.35;
          this.delayGain = this.ctx.createGain();
          this.delayGain.gain.value = 0.0;
          this.delayNode.connect(this.delayFeedback);
          this.delayFeedback.connect(this.delayNode);
          this.delayNode.connect(this.delayGain);

          this.convolverNode = this.ctx.createConvolver();
          this.convolverNode.buffer = this._createReverbImpulse(this.ctx);
          this.reverbGain = this.ctx.createGain();
          this.reverbGain.gain.value = 0.0;

          this.masterGain = this.ctx.createGain();
          this.analyserNode = this.ctx.createAnalyser();
          this.analyserNode.fftSize = 128;
          this.analyserNode.smoothingTimeConstant = 0.8;

          this.normGain = this.ctx.createGain();
          this.normLimiter = this.ctx.createDynamicsCompressor();
          this.normLimiter.threshold.value = -2;
          this.normLimiter.knee.value = 0;
          this.normLimiter.ratio.value = 20;
          this.normLimiter.attack.value = 0.003;
          this.normLimiter.release.value = 0.1;
          this.levelAnalyser = this.ctx.createAnalyser();
          this.levelAnalyser.fftSize = 2048;
          this.levelBuf = new Float32Array(this.levelAnalyser.fftSize);

          this.eqLow = this.ctx.createBiquadFilter();
          this.eqLow.type = 'lowshelf';
          this.eqLow.frequency.value = 200;
          this.eqMid = this.ctx.createBiquadFilter();
          this.eqMid.type = 'peaking';
          this.eqMid.frequency.value = 1000;
          this.eqMid.Q.value = 0.9;
          this.eqHigh = this.ctx.createBiquadFilter();
          this.eqHigh.type = 'highshelf';
          this.eqHigh.frequency.value = 4000;
          this.eqLow.connect(this.eqMid);
          this.eqMid.connect(this.eqHigh);

          const EQ_BAND_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
          this.eqBands = EQ_BAND_FREQS.map(f => {
            const node = this.ctx.createBiquadFilter();
            node.type = 'peaking';
            node.frequency.value = f;
            node.Q.value = 1.1;
            node.gain.value = 0;
            return node;
          });
          this.eqHigh.connect(this.eqBands[0]);
          for (let i = 0; i < this.eqBands.length - 1; i++) {
            this.eqBands[i].connect(this.eqBands[i + 1]);
          }

          this.bus = this.ctx.createGain();
          this.fadeGain = this.ctx.createGain();
          this.fadeGain.gain.value = 1.0;
          this.masterGain.connect(this.normGain);
          this.normGain.connect(this.normLimiter);
          this.hpPreamp = this.ctx.createGain();
          this.hpFilters = [];
          // Signature preset slot (see _applySignature).
          this.sigIn = this.ctx.createGain();
          this.sigIn.channelCount = 2;
          this.sigIn.channelCountMode = 'explicit';
          this.sigIn.channelInterpretation = 'speakers';
          this.sigDry = this.ctx.createGain();
          this.sigOut = this.ctx.createGain();
          // Auto Studio Remaster slot (after headphone correction): rmIn -> rmDry -> normIn, or through the chain.
          this.rmIn = this.ctx.createGain();
          this.rmDry = this.ctx.createGain();
          // Normalizer input. The loudness meter listens here, before the normalizer's own gain.
          // (It used to listen to the 3-band EQ, which only carries sound while that EQ is on, so the normalizer
          // saw silence and never moved.)
          this.normIn = this.ctx.createGain();
          this.rmIn.connect(this.rmDry);
          this.rmDry.connect(this.normIn);
          this.normIn.connect(this.normGain);
          // Rough K-weighting (ITU-R BS.1770): low cut at 38 Hz, +4 dB shelf above 1.5 kHz.
          this.kHp = this.ctx.createBiquadFilter();
          this.kHp.type = 'highpass'; this.kHp.frequency.value = 38; this.kHp.Q.value = 0.5;
          this.kShelf = this.ctx.createBiquadFilter();
          this.kShelf.type = 'highshelf'; this.kShelf.frequency.value = 1500; this.kShelf.gain.value = 4;
          this.normIn.connect(this.kHp);
          this.kHp.connect(this.kShelf);
          this.kShelf.connect(this.levelAnalyser);
          this.masterGain.disconnect(this.normGain);
          this.masterGain.connect(this.sigIn);
          this.sigIn.connect(this.sigDry);
          this.sigDry.connect(this.sigOut);
          this.sigOut.connect(this.rmIn);
          this.normLimiter.connect(this.analyserNode);
          // 8D sits between the analyser and the fade stage: a dry path plus an orbiting HRTF panner,
          // mixed by audioSettings.spatial8d (0 = off, 1 = full orbit).
          this.spatialDry = this.ctx.createGain();
          this.spatialDry.gain.value = 1.0;
          this.analyserNode.connect(this.spatialDry);
          this.spatialDry.connect(this.fadeGain);
          // Your volume is the very last stage. It used to be set on the <audio> element, i.e. before the graph,
          // so the normalizer measured "quiet" whenever the volume was low and boosted it back up.
          this.userGain = this.ctx.createGain();
          this.fadeGain.connect(this.userGain);
          this.userGain.connect(this.ctx.destination);

          this.graphInitialized = true;
          this._updateRouting();
          this._applyHeadphoneEq();
          this.setNormalizeEnabled(!!this.normalizeOn);
          this._applyMasterVolume();
          if (this.remaster) this._applyRemaster(true);
        } catch (e) {
          console.warn('[AudioEngine] Graph initialization notice:', e);
        }
      }

      this.applySettings();
      if (audioElement.paused) this.suspendAudioContextDebounced(5000);
    }


    _isEqActive() {
      const s = this.audioSettings;
      if (s.eq && (s.eq.low !== 0 || s.eq.mid !== 0 || s.eq.high !== 0)) return true;
      if (Array.isArray(s.eqBands) && s.eqBands.some(v => v !== 0)) return true;
      return false;
    }

    _updateRouting() {
      if (!this.graphInitialized || !this.mediaSource) return;

      const s = this.audioSettings;
      const isEqOn = this._isEqActive();
      const isReverbOn = (s.reverb || 0) > 0;
      const isEchoOn = (s.echo || 0) > 0;
      const isDistortionOn = (s.distortion || 0) > 0;
      const isHqOn = !!this.hqEnabled;

      const stateKey = `${isHqOn}_${isEqOn}_${isReverbOn}_${isEchoOn}_${isDistortionOn}`;
      if (this._routingState === stateKey) {
        this._applyHqParams();
        return;
      }
      this._routingState = stateKey;

      try {
        this.mediaSource.disconnect();
        this.stdInput.disconnect();
        this.hqLimiter.disconnect();
        this.bus.disconnect();
        this.dryGain.disconnect();
        if (this.eqBands && this.eqBands.length) {
          this.eqBands[this.eqBands.length - 1].disconnect();
        }
        this.distortionNode.disconnect();
        this.distortionGain.disconnect();
        this.delayGain.disconnect();
        this.convolverNode.disconnect();
        this.reverbGain.disconnect();
      } catch (e) {}

      const inputNode = isHqOn ? this.hqLimiter : this.stdInput;
      if (isHqOn) {
        this.mediaSource.connect(this.hqInput);
      } else {
        this.mediaSource.connect(this.stdInput);
      }

      if (isEqOn) {
        inputNode.connect(this.eqLow);
        this.eqBands[this.eqBands.length - 1].connect(this.bus);
      } else {
        inputNode.connect(this.bus);
      }

      this.bus.connect(this.dryGain);
      this.dryGain.connect(this.masterGain);

      if (isDistortionOn) {
        this.bus.connect(this.distortionNode);
        this.distortionNode.connect(this.distortionGain);
        this.distortionGain.connect(this.masterGain);
      }

      if (isEchoOn) {
        this.bus.connect(this.delayNode);
        this.delayGain.connect(this.masterGain);
      }

      if (isReverbOn) {
        this.bus.connect(this.convolverNode);
        this.convolverNode.connect(this.reverbGain);
        this.reverbGain.connect(this.masterGain);
      }

      this._applyHqParams();
    }

    flushEffects() {
      if (!this.graphInitialized || !this.ctx) return;
      try {
        if (this.delayNode) {
          const dt = this.delayNode.delayTime.value;
          const fb = this.delayFeedback ? this.delayFeedback.gain.value : 0.35;
          try {
            this.delayNode.disconnect();
            if (this.delayFeedback) this.delayFeedback.disconnect();
          } catch (e) {}
          this.delayNode = this.ctx.createDelay(1.0);
          this.delayNode.delayTime.value = dt;
          this.delayFeedback = this.ctx.createGain();
          this.delayFeedback.gain.value = fb;
          this.delayNode.connect(this.delayFeedback);
          this.delayFeedback.connect(this.delayNode);
          if (this.delayGain) this.delayNode.connect(this.delayGain);
        }
        if (this.convolverNode) {
          try {
            this.convolverNode.disconnect();
          } catch (e) {}
          this.convolverNode = this.ctx.createConvolver();
          this.convolverNode.buffer = this._createReverbImpulse(this.ctx);
          if (this.reverbGain) this.convolverNode.connect(this.reverbGain);
        }
        this._routingState = null;
        this._updateRouting();
      } catch (e) {}
    }


    // profile: { preamp: dB, filters: [[type, fc, gainDb, q], ...] } (type 0 peaking, 1 low shelf, 2 high shelf), or null.
    setHeadphoneEq(profile) {
      this.headphoneEq = profile && Array.isArray(profile.filters) && profile.filters.length ? profile : null;
      if (this.graphInitialized) this._applyHeadphoneEq();
    }

    _applyHeadphoneEq() {
      if (!this.ctx || !this.masterGain || !this.normGain || !this.hpPreamp) return;
      const src = this.sigOut || this.masterGain;
      const dest = this.rmIn || this.normGain;
      try { src.disconnect(); } catch (e) {}
      try { this.hpPreamp.disconnect(); } catch (e) {}
      (this.hpFilters || []).forEach((f) => { try { f.disconnect(); } catch (e) {} });
      this.hpFilters = [];
      const prof = this.headphoneEq;
      if (!prof) {
        src.connect(dest);
        return;
      }
      const TYPES = ['peaking', 'lowshelf', 'highshelf'];
      const nyquist = this.ctx.sampleRate / 2;
      this.hpPreamp.gain.value = Math.pow(10, Math.max(-24, Math.min(0, Number(prof.preamp) || 0)) / 20);
      let last = this.hpPreamp;
      prof.filters.slice(0, 16).forEach(([type, fc, gain, q]) => {
        if (!(fc > 0 && fc < nyquist)) return;
        const f = this.ctx.createBiquadFilter();
        f.type = TYPES[type] || 'peaking';
        f.frequency.value = fc;
        f.gain.value = Math.max(-24, Math.min(24, Number(gain) || 0));
        // AutoEq's shelf Q is the RBJ cookbook Q, which Web Audio shelves ignore: they always use slope 1 (Q 0.707).
        if (f.type === 'peaking') f.Q.value = Math.max(0.05, Math.min(30, Number(q) || 1));
        last.connect(f);
        last = f;
        this.hpFilters.push(f);
      });
      src.connect(this.hpPreamp);
      last.connect(dest);
    }

    // ---- Signature presets ----
    // Stereo noise impulse with an exponential decay to -60 dB over `seconds`; 'dark' rolls off its highs.
    _impulse(seconds, variant) {
      const ctx = this.ctx;
      const key = ctx.sampleRate + ':' + seconds + ':' + (variant || '');
      this._irCache = this._irCache || {};
      if (this._irCache[key]) return this._irCache[key];
      const rate = ctx.sampleRate;
      const len = Math.max(1, Math.floor(rate * seconds));
      const buf = ctx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let lp = 0;
        const smooth = variant === 'dark' ? 0.82 : (variant === 'room' ? 0.35 : 0.55);
        for (let i = 0; i < len; i++) {
          const n = Math.random() * 2 - 1;
          lp = lp * smooth + n * (1 - smooth);
          // Tiled room: a few hard early reflections in the first 30 ms.
          const early = variant === 'room' && i < rate * 0.03 && Math.random() < 0.002 ? (Math.random() * 2 - 1) * 4 : 0;
          d[i] = (lp + early) * Math.exp(-6.9 * i / len);
        }
      }
      this._irCache[key] = buf;
      return buf;
    }

    _softClip(k) {
      const n = 1024;
      const curve = new Float32Array(n);
      // tanh(kx)/k: same level for normal signals (slope 1 at 0), only the peaks round off.
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        curve[i] = Math.tanh(k * x) / k;
      }
      return curve;
    }

    // Each builder returns { input, output, nodes, oscs, params }.
    _buildSignature(name) {
      const ctx = this.ctx;
      const nodes = [];
      const oscs = [];
      const N = (node) => { nodes.push(node); return node; };
      const gain = (v) => { const g = N(ctx.createGain()); g.gain.value = v; return g; };
      const biquad = (type, f, q, g) => { const b = N(ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; if (q !== undefined) b.Q.value = q; if (g !== undefined) b.gain.value = g; return b; };
      const delay = (t, max) => { const d = N(ctx.createDelay(max || 0.1)); d.delayTime.value = t; return d; };
      const conv = (sec, v) => { const c = N(ctx.createConvolver()); c.buffer = this._impulse(sec, v); return c; };
      const shaper = (k) => { const w = N(ctx.createWaveShaper()); w.curve = this._softClip(k); w.oversample = '2x'; return w; };
      const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; oscs.push(o); return o; };
      const input = gain(1);
      const output = gain(1);
      const params = {};

      if (name === 'bathroom') {
        // Through the wall: highs gone, the kick in the floor, a small tiled room, a 12 ms Haas offset.
        const lp = biquad('lowpass', 290, 1.4);
        const thump = biquad('peaking', 68, 1.8, 7);
        input.connect(lp); lp.connect(thump);
        const roomDry = gain(0.65);
        const room = conv(0.45, 'room');
        const roomWet = gain(0.35);
        const sum = gain(1);
        thump.connect(roomDry); roomDry.connect(sum);
        thump.connect(room); room.connect(roomWet); roomWet.connect(sum);
        const split = N(ctx.createChannelSplitter(2));
        const merge = N(ctx.createChannelMerger(2));
        const haas = delay(0.012);
        sum.connect(split);
        split.connect(merge, 0, 0);
        split.connect(haas, 1); haas.connect(merge, 0, 1);
        merge.connect(output);
        Object.assign(params, { lp, roomWet, roomDry });
      } else if (name === 'ethereal') {
        // Dry centre kept, plus a strong tape-warm, chorus-widened 4.2 s cathedral with a shimmer shelf.
        // (The first 70/30 mix was so subtle it sounded like nothing.)
        const dry = gain(0.7);
        input.connect(dry); dry.connect(output);
        const tape = shaper(1.6);
        input.connect(tape);
        const split = N(ctx.createChannelSplitter(2));
        const merge = N(ctx.createChannelMerger(2));
        const dl = delay(0.018), dr = delay(0.018);
        const lfo = osc('sine', 0.35);
        const depthL = gain(0.0035), depthR = gain(-0.0035);
        lfo.connect(depthL); depthL.connect(dl.delayTime);
        lfo.connect(depthR); depthR.connect(dr.delayTime);
        tape.connect(split);
        split.connect(dl, 0); split.connect(dr, 1);
        dl.connect(merge, 0, 0); dr.connect(merge, 0, 1);
        const cathedral = conv(4.2, 'hall');
        const shimmer = biquad('highshelf', 6000, undefined, 6);
        const chorusDirect = gain(0.45);
        const wet = gain(0.75);
        merge.connect(cathedral); cathedral.connect(shimmer); shimmer.connect(wet);
        merge.connect(chorusDirect); chorusDirect.connect(wet);
        wet.connect(output);
      } else if (name === 'soulbleed') {
        // Mid/side: side +4.5 dB, mid above 300 Hz -8 dB (bass and kick untouched), and that mid fed to a dark tail.
        const split = N(ctx.createChannelSplitter(2));
        input.connect(split);
        const mid = gain(0.5), side = gain(0.5), invR = gain(-1);
        split.connect(mid, 0); split.connect(mid, 1);
        split.connect(side, 0); split.connect(invR, 1); invR.connect(side);
        const sideUp = gain(Math.pow(10, 4.5 / 20));
        side.connect(sideUp);
        const midLow = biquad('lowpass', 300, 0.707);
        const midHigh = biquad('highpass', 300, 0.707);
        const midHighDown = gain(Math.pow(10, -8 / 20));
        mid.connect(midLow); mid.connect(midHigh); midHigh.connect(midHighDown);
        const midOut = gain(1);
        midLow.connect(midOut); midHighDown.connect(midOut);
        const sideNeg = gain(-1);
        sideUp.connect(sideNeg);
        const merge = N(ctx.createChannelMerger(2));
        midOut.connect(merge, 0, 0); midOut.connect(merge, 0, 1);
        sideUp.connect(merge, 0, 0); sideNeg.connect(merge, 0, 1);
        merge.connect(output);
        const tap = delay(0.27, 1);
        const fb = gain(0.32);
        tap.connect(fb); fb.connect(tap);
        const dark = biquad('lowpass', 2400, 0.707);
        const ghost = conv(2.4, 'dark');
        const ghostOut = gain(0.45);
        midHigh.connect(tap); tap.connect(dark); dark.connect(ghost); ghost.connect(ghostOut); ghostOut.connect(output);
      } else if (name === 'vhs') {
        // A 90s CRT TV playing a worn tape: 85 % mono (one centre speaker), a 250 Hz-3.9 kHz cabinet with a hollow
        // 340 Hz box resonance and a 2.15 kHz bite, a crunchy VCR preamp (asymmetric tanh + 12-bit steps), wow and
        // flutter on a 15 ms tape delay, plus gated tape hiss and 60 Hz hum. Tape Wear scales crunch, wobble and hiss.
        const split = N(ctx.createChannelSplitter(2));
        const merge = N(ctx.createChannelMerger(2));
        input.connect(split);
        // side x0.15: L' = 0.575 L + 0.425 R, R' = 0.575 R + 0.425 L
        const ll = gain(0.575), rr = gain(0.575), lr = gain(0.425), rl = gain(0.425);
        split.connect(ll, 0); split.connect(lr, 0);
        split.connect(rr, 1); split.connect(rl, 1);
        ll.connect(merge, 0, 0); rl.connect(merge, 0, 0);
        rr.connect(merge, 0, 1); lr.connect(merge, 0, 1);
        const hp = biquad('highpass', 250, 0.9);
        const box = biquad('peaking', 340, 2.2, 4.5);
        const bite = biquad('peaking', 2150, 1.6, 7.5);
        const lp = biquad('lowpass', 3900, 1.2);
        const pre = N(ctx.createWaveShaper());
        pre.oversample = '2x';
        const makeup = gain(0.68);
        const tapeDelay = delay(0.015, 0.1);
        const wow = osc('sine', 0.65), flutter = osc('triangle', 7.5);
        const wowDepth = gain(0.0028), flutterDepth = gain(0.00045);
        wow.connect(wowDepth); wowDepth.connect(tapeDelay.delayTime);
        flutter.connect(flutterDepth); flutterDepth.connect(tapeDelay.delayTime);
        merge.connect(hp); hp.connect(box); box.connect(bite); bite.connect(lp); lp.connect(pre); pre.connect(makeup);
        makeup.connect(tapeDelay); tapeDelay.connect(output);
        // Tape hiss + CRT hum, looping, muted while paused (see _gateHiss).
        const hiss = ctx.createBufferSource();
        hiss.buffer = this._vhsHissBuffer();
        hiss.loop = true;
        oscs.push(hiss);
        const hissGain = gain(0);
        hiss.connect(hissGain); hissGain.connect(output);
        Object.assign(params, { pre, bite, wowDepth, flutterDepth, hissGain });
      } else {
        return null;
      }
      oscs.forEach((o) => o.start());
      return { input, output, nodes, oscs, params };
    }

    _applySignature(name) {
      const known = ['bathroom', 'ethereal', 'soulbleed', 'vhs'];
      name = known.includes(name) ? name : '';
      if (!this.ctx || !this.sigIn) return;
      const current = this._sig ? this._sig.name : '';
      if (current === name) return;
      const ctx = this.ctx;
      const now = ctx.currentTime;
      const T = 0.35;
      const old = this._sig;
      this._sig = null;
      if (old) {
        const g = old.wet.gain;
        g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + T);
        setTimeout(() => this._teardownSignature(old), T * 1000 + 150);
      }
      const dry = this.sigDry.gain;
      dry.cancelScheduledValues(now); dry.setValueAtTime(dry.value, now);
      const chain = name ? this._buildSignature(name) : null;
      if (!chain) { dry.linearRampToValueAtTime(1, now + T); return; }
      chain.name = name;
      chain.wet = ctx.createGain();
      // The fade-in waits 20 ms so delay lines (Haas, chorus, tape) are full before they are heard.
      const L = 0.02;
      chain.wet.gain.setValueAtTime(0, now);
      chain.wet.gain.setValueAtTime(0, now + L);
      this.sigIn.connect(chain.input);
      chain.output.connect(chain.wet);
      chain.wet.connect(this.sigOut);
      chain.wet.gain.linearRampToValueAtTime(1, now + L + T);
      dry.setValueAtTime(dry.value, now + L);
      dry.linearRampToValueAtTime(0, now + L + T);
      this._sig = chain;
      if (name === 'bathroom') this._applyDoor(this.door || 0, true);
      if (name === 'vhs') { this._applyTapeWear(true); this._gateHiss(); }
    }

    // ---- VHS Melt: Tape Wear 0..1 (0.5 = the reference sound) ----
    setTapeWear(amount) {
      const v = Number(amount);
      this.tapeWear = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
      this._applyTapeWear(false);
    }

    _vhsWear() { return Number.isFinite(this.tapeWear) ? this.tapeWear : 0.5; }

    _applyTapeWear(instant) {
      const c = this._sig;
      if (!c || c.name !== 'vhs' || !this.ctx) return;
      const w = this._vhsWear();
      const p = c.params;
      const drive = 1.5 + 4.6 * w; // 3.8 at 50 %
      if (instant || Math.abs((p.drive || 0) - drive) > 0.04) {
        p.drive = drive;
        p.pre.curve = this._vcrCurve(drive);
      }
      const set = (param, v) => (instant ? param.setValueAtTime(v, this.ctx.currentTime) : this._glide(param, v));
      set(p.wowDepth.gain, 0.0056 * w);
      set(p.flutterDepth.gain, 0.0009 * w);
      set(p.bite.gain, 4.5 + 6 * w);
      this._gateHiss();
    }

    // Asymmetric tanh (even harmonics, like a tape preamp) quantized to 12-bit steps.
    _vcrCurve(k) {
      const n = 4096;
      const curve = new Float32Array(n);
      const bias = 0.12;
      const off = Math.tanh(k * bias);
      const norm = Math.max(Math.abs(Math.tanh(k * (1 + bias)) - off), Math.abs(Math.tanh(k * (-1 + bias)) - off)) || 1;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        const y = (Math.tanh(k * (x + bias)) - off) / norm;
        curve[i] = Math.round(y * 2048) / 2048;
      }
      return curve;
    }

    _vhsHissBuffer() {
      if (this._hissBuf && this._hissBuf.sampleRate === this.ctx.sampleRate) return this._hissBuf;
      const rate = this.ctx.sampleRate;
      const len = Math.floor(rate * 4); // 4 s loop; 60 Hz fits it exactly
      const buf = this.ctx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let hpPrev = 0, hpOut = 0, lp = 0;
        for (let i = 0; i < len; i++) {
          const n = Math.random() * 2 - 1;
          hpOut = 0.97 * (hpOut + n - hpPrev); hpPrev = n; // cut the rumble: hiss lives up high
          lp = lp * 0.45 + hpOut * 0.55;                    // and soften the very top
          const t = i / rate;
          const hum = 0.32 * Math.sin(2 * Math.PI * 60 * t) + 0.14 * Math.sin(2 * Math.PI * 120 * t) + 0.07 * Math.sin(2 * Math.PI * 180 * t);
          d[i] = lp * 0.55 + hum;
        }
      }
      this._hissBuf = buf;
      return buf;
    }

    _gateHiss() {
      const c = this._sig;
      if (!c || c.name !== 'vhs' || !c.params.hissGain || !this.ctx) return;
      const el = this._attachedElement;
      const playing = !!(el && !el.paused && !el.ended);
      const target = playing ? 0.016 * (0.4 + 1.2 * this._vhsWear()) : 0;
      try {
        const g = c.params.hissGain.gain;
        g.cancelScheduledValues(this.ctx.currentTime);
        g.setTargetAtTime(target, this.ctx.currentTime, playing ? 0.15 : 0.02);
      } catch (_) {}
    }

    // ---- Auto Studio Remaster: universal target curve, harmonic exciter, stereo widener ----
    // mode: 'warm' | 'crisp' | 'punch'; null turns it off.
    setRemaster(mode) {
      const MODES = ['warm', 'crisp', 'punch'];
      this.remaster = MODES.includes(mode) ? mode : null;
      if (this.graphInitialized) this._applyRemaster(false);
    }

    // Three clearly different characters (the first version moved each band ~1.5 dB and they all sounded alike):
    //   Warm      - full, round low end, smooth darker top, gentle width
    //   Crisp HD  - clean low-mids, forward vocals, sparkling restored highs, wide stage
    //   Max Punch - deep sub and kick, parallel compression for drive, bright enough to cut through
    _remasterParams(mode) {
      return ({
        warm:  { trim: -3.0, sub: 2.0, low: 5.5, mud: -1.0, pres: -0.5, tilt: -2.5, comp: 0.0, exc: 0.05, air: 0.0, width: 1.5 },
        crisp: { trim: -1.0, sub: 2.5, low: 0.0, mud: -4.0, pres: 3.5, tilt: 1.5, comp: 0.0, exc: 0.30, air: 5.0, width: 3.5 },
        punch: { trim: -3.5, sub: 6.5, low: 2.5, mud: -4.0, pres: 2.5, tilt: 0.5, comp: 0.7, exc: 0.15, air: 2.5, width: 2.0 },
      })[mode] || null;
    }

    _buildRemaster() {
      const ctx = this.ctx;
      const nodes = [];
      const N = (n) => { nodes.push(n); return n; };
      const gain = (v) => { const g = N(ctx.createGain()); g.gain.value = v; return g; };
      const biquad = (type, f, q, g) => { const b = N(ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; if (q !== undefined) b.Q.value = q; if (g !== undefined) b.gain.value = g; return b; };
      const input = gain(1);
      const trim = gain(1);
      const sub = biquad('peaking', 58, 1.1, 0);      // sub / kick punch
      const low = biquad('lowshelf', 140, undefined, 0); // body and warmth
      const mud = biquad('peaking', 290, 1.4, 0);     // boxy headset veil
      const pres = biquad('peaking', 3200, 1.2, 0);   // vocal clarity
      const tilt = biquad('highshelf', 7000, undefined, 0); // darker (warm) or brighter (crisp) top
      input.connect(trim); trim.connect(sub); sub.connect(low); low.connect(mud); mud.connect(pres); pres.connect(tilt);
      // Parallel ("New York") compression: a squashed copy under the original adds drive without killing peaks.
      const glue = gain(1);
      tilt.connect(glue);
      const comp = N(ctx.createDynamicsCompressor());
      comp.threshold.value = -32; comp.knee.value = 8; comp.ratio.value = 5; comp.attack.value = 0.008; comp.release.value = 0.14;
      const compWet = gain(0);
      tilt.connect(comp); comp.connect(compWet); compWet.connect(glue);
      // Exciter: the band above 5.5 kHz, driven into a saturator so it really makes new harmonics (the quiet band
      // barely touched the curve before), cleaned of its low products, blended back in.
      const sum = gain(1);
      glue.connect(sum);
      const excHp = biquad('highpass', 5500, 0.707);
      const excDrive = gain(8);
      const exciter = N(ctx.createWaveShaper());
      exciter.oversample = '4x';
      const n = 2048, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        curve[i] = Math.tanh(2.5 * x) / Math.tanh(2.5) + 0.25 * x * x;
      }
      exciter.curve = curve;
      const excClean = biquad('highpass', 4500, 0.707);
      const excWet = gain(0);
      glue.connect(excHp); excHp.connect(excDrive); excDrive.connect(exciter); exciter.connect(excClean); excClean.connect(excWet); excWet.connect(sum);
      const air = biquad('highshelf', 11000, undefined, 0);
      sum.connect(air);
      // Widener: side above 300 Hz up, side below 120 Hz removed (bass stays mono).
      const split = N(ctx.createChannelSplitter(2));
      const merge = N(ctx.createChannelMerger(2));
      air.connect(split);
      const mid = gain(1), side = gain(1);
      const mL = gain(0.5), mR = gain(0.5), sL = gain(0.5), sR = gain(-0.5);
      split.connect(mL, 0); split.connect(mR, 1); mL.connect(mid); mR.connect(mid);
      split.connect(sL, 0); split.connect(sR, 1); sL.connect(side); sR.connect(side);
      const sideKeep = biquad('highpass', 120, 0.707);
      const sideHigh = biquad('highpass', 300, 0.707);
      const sideBoost = gain(0);
      const sideOut = gain(1);
      side.connect(sideKeep); sideKeep.connect(sideOut);
      side.connect(sideHigh); sideHigh.connect(sideBoost); sideBoost.connect(sideOut);
      const sideNeg = gain(-1);
      sideOut.connect(sideNeg);
      mid.connect(merge, 0, 0); mid.connect(merge, 0, 1);
      sideOut.connect(merge, 0, 0); sideNeg.connect(merge, 0, 1);
      const output = gain(1);
      merge.connect(output);
      return { input, output, nodes, params: { trim, sub, low, mud, pres, tilt, compWet, excWet, air, sideBoost } };
    }

    _applyRemaster(instant) {
      if (!this.ctx || !this.rmIn || !this.normIn) return;
      const now = this.ctx.currentTime;
      const T = instant ? 0.01 : 0.3;
      const p = this._remasterParams(this.remaster);
      if (p && !this._rm) {
        const chain = this._buildRemaster();
        chain.wet = this.ctx.createGain();
        chain.wet.gain.setValueAtTime(0, now);
        this.rmIn.connect(chain.input);
        chain.output.connect(chain.wet);
        chain.wet.connect(this.normIn);
        this._rm = chain;
      }
      const c = this._rm;
      if (!c) return;
      const ramp = (param, v) => { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); param.linearRampToValueAtTime(v, now + T); };
      if (p) {
        clearTimeout(this._rmTeardown);
        const q = c.params;
        ramp(q.trim.gain, Math.pow(10, p.trim / 20));
        ramp(q.sub.gain, p.sub);
        ramp(q.low.gain, p.low);
        ramp(q.mud.gain, p.mud);
        ramp(q.pres.gain, p.pres);
        ramp(q.tilt.gain, p.tilt);
        ramp(q.compWet.gain, p.comp * 2.5);
        ramp(q.excWet.gain, p.exc / 4);
        ramp(q.air.gain, p.air);
        ramp(q.sideBoost.gain, Math.pow(10, p.width / 20) - 1);
        ramp(c.wet.gain, 1);
        ramp(this.rmDry.gain, 0);
      } else {
        ramp(c.wet.gain, 0);
        ramp(this.rmDry.gain, 1);
        clearTimeout(this._rmTeardown);
        this._rmTeardown = setTimeout(() => {
          if (this.remaster || this._rm !== c) return;
          try { this.rmIn.disconnect(c.input); } catch (_) {}
          [c.input, ...c.nodes, c.output, c.wet].forEach((x) => { try { x.disconnect(); } catch (_) {} });
          this._rm = null;
        }, T * 1000 + 150);
      }
    }

    // ---- Normalizer stage B: while on, a mastering limiter catches what the boost pushes up ----
    setNormalizeEnabled(on) {
      this.normalizeOn = !!on;
      const L = this.normLimiter;
      if (!L || !this.ctx) return;
      const v = on
        ? { threshold: -3.5, knee: 6, ratio: 12, attack: 0.003, release: 0.15 }
        : { threshold: -2, knee: 0, ratio: 20, attack: 0.003, release: 0.1 };
      Object.keys(v).forEach((k) => this.setParamNow(L[k], v[k], v[k]));
    }

    _teardownSignature(chain) {
      try { this.sigIn.disconnect(chain.input); } catch (e) {}
      chain.oscs.forEach((o) => { try { o.stop(); } catch (e) {} try { o.disconnect(); } catch (e) {} });
      [chain.input, ...chain.nodes, chain.output, chain.wet].forEach((n) => { try { n.disconnect(); } catch (e) {} });
    }

    // 3AM Bathroom's door: 0 = shut (290 Hz, 35 % room), 1 = open (20 kHz, no room). Exponential sweep.
    setDoor(amount) {
      this.door = Math.max(0, Math.min(1, Number(amount) || 0));
      this._applyDoor(this.door, false);
    }

    _applyDoor(d, instant) {
      const c = this._sig;
      if (!c || c.name !== 'bathroom' || !this.ctx) return;
      const now = this.ctx.currentTime;
      const f = 290 * Math.pow(20000 / 290, d);
      const wet = 0.35 * (1 - d);
      if (instant) {
        c.params.lp.frequency.setValueAtTime(f, now);
        c.params.roomWet.gain.setValueAtTime(wet, now);
        c.params.roomDry.gain.setValueAtTime(1 - wet, now);
      } else {
        c.params.lp.frequency.setTargetAtTime(f, now, 0.05);
        c.params.roomWet.gain.setTargetAtTime(wet, now, 0.05);
        c.params.roomDry.gain.setTargetAtTime(1 - wet, now, 0.05);
      }
    }

    // Short glide instead of a jump, so a moving setting never clicks.
    _glide(param, value) {
      if (!param) return;
      if (this.ctx && param.setTargetAtTime) param.setTargetAtTime(value, this.ctx.currentTime, 0.012);
      else param.value = value;
    }

    setHqEnabled(enabled) {
      this.hqEnabled = enabled;
      if (this.graphInitialized) {
        this._updateRouting();
        this._applyHqParams();
      }
    }

    setHqSettings(settings) {
      Object.assign(this.hqSettings, settings);
      if (this.graphInitialized) this._applyHqParams();
    }

    _applyHqParams() {
      if (!this.hqCompressor) return;

      if (!this.hqEnabled) {
        const ctx = this.ctx;
        if (ctx) {
          if (this.hqBass) this.hqBass.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
          if (this.hqVocal) this.hqVocal.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
          if (this.hqAir) this.hqAir.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
        }
        return;
      }

      let baseBass = 0, baseVocal = 0, baseAir = 0;
      let satAmount = 0;

      this.hqCompressor.threshold.value = -12;
      this.hqCompressor.knee.value = 10;
      this.hqCompressor.ratio.value = 1.5;
      this.hqCompressor.attack.value = 0.01;
      this.hqCompressor.release.value = 0.1;

      switch (this.hqSettings.engine) {
        case 'hqmusic-3':
          satAmount = 0.5;
          break;
        case 'glyphs-7B':
          satAmount = 0.2;
          baseAir = 2.5;
          this.hqAir.frequency.value = 9000;
          break;
        case 'fyro1.1':
          satAmount = 0.2;
          baseBass = 3.0;
          this.hqBass.frequency.value = 80;
          this.hqCompressor.ratio.value = 2.0;
          break;
      }

      this.hqSaturation.curve = this._makeHarmonicCurve(satAmount);

      this.hqBass.gain.value = Math.max(-4, Math.min(4, baseBass + (this.hqSettings.bass * 0.08)));
      this.hqVocal.gain.value = Math.max(-4, Math.min(4, baseVocal + (this.hqSettings.vocal * 0.08)));
      this.hqAir.gain.value = Math.max(-4, Math.min(4, baseAir + (this.hqSettings.air * 0.08)));
    }


    setAudioSettings(settings) {
      Object.assign(this.audioSettings, settings);
      this.applySettings();
    }

    setEq(eq) {
      if (!eq) return;
      if (!this.audioSettings.eq) this.audioSettings.eq = { low: 0, mid: 0, high: 0 };
      const clamp = v => Math.max(-12, Math.min(12, typeof v === 'number' ? v : 0));
      if (eq.low !== undefined) this.audioSettings.eq.low = clamp(eq.low);
      if (eq.mid !== undefined) this.audioSettings.eq.mid = clamp(eq.mid);
      if (eq.high !== undefined) this.audioSettings.eq.high = clamp(eq.high);
      if (this.eqLow) this.eqLow.gain.value = this.audioSettings.eq.low;
      if (this.eqMid) this.eqMid.gain.value = this.audioSettings.eq.mid;
      if (this.eqHigh) this.eqHigh.gain.value = this.audioSettings.eq.high;
      if (this.graphInitialized) this._updateRouting();
    }

    setEqBands(gains) {
      if (!Array.isArray(gains)) return;
      if (!Array.isArray(this.audioSettings.eqBands)) {
        this.audioSettings.eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      }
      const clamp = v => Math.max(-12, Math.min(12, typeof v === 'number' ? v : 0));
      for (let i = 0; i < 10; i++) {
        const val = clamp(gains[i]);
        this.audioSettings.eqBands[i] = val;
        if (this.eqBands && this.eqBands[i]) {
          if (this.ctx && this.eqBands[i].gain.setTargetAtTime) {
            this.eqBands[i].gain.setTargetAtTime(val, this.ctx.currentTime, 0.02);
          } else {
            this.eqBands[i].gain.value = val;
          }
        }
      }
      if (this.graphInitialized) this._updateRouting();
    }

    setVolume(volume, isMuted) {
      this.volume = volume;
      this.isMuted = isMuted;
      this._applyMasterVolume();
    }

    applySettings(audioElement) {
      const s = this.audioSettings;

      if (audioElement) {
        if (s.speedPitch !== 1.0 || s.pitch !== 0) {
          audioElement.preservesPitch = false;
          audioElement.webkitPreservesPitch = false;
          audioElement.mozPreservesPitch = false;
          const pitchMultiplier = Math.pow(2, s.pitch / 12);
          audioElement.playbackRate = s.speedPitch * pitchMultiplier;
        } else {
          audioElement.preservesPitch = true;
          audioElement.webkitPreservesPitch = true;
          audioElement.mozPreservesPitch = true;
          audioElement.playbackRate = s.speed;
        }
      }

      if (s.eq) this.setEq(s.eq);
      if (s.eqBands) this.setEqBands(s.eqBands);

      if (this.reverbGain) this._glide(this.reverbGain.gain, s.reverb / 100);

      if (this.delayGain) this._glide(this.delayGain.gain, s.echo / 100);

      if (this.distortionNode && this.distortionGain) {
        if (s.distortion > 0) {
          this.distortionNode.curve = this._makeDistortionCurve(s.distortion);
          this._glide(this.distortionGain.gain, (s.distortion / 100) * 0.75);
          if (this.dryGain) this._glide(this.dryGain.gain, 1.0 - (s.distortion / 100) * 0.4);
        } else {
          this._glide(this.distortionGain.gain, 0.0);
          if (this.dryGain) this._glide(this.dryGain.gain, 1.0);
        }
      }

      if (this.graphInitialized) this._updateRouting();
      this._applySpatial(s.spatial8d || 0);
      this._applySignature(s.signature || '');
      this._applyMasterVolume();
    }

    // Builds the 8D path on first use: the sound circles the listener once every ~10 s.
    _ensureSpatialPath() {
      if (this.spatialWet || !this.ctx || !this.analyserNode || !this.fadeGain) return !!this.spatialWet;
      const ctx = this.ctx;
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.positionY.value = 0;

      // Two LFOs a quarter turn apart (sine on X, cosine on Z) trace a circle around the head.
      const radius = 2.2;
      const lfoX = ctx.createOscillator();
      const lfoZ = ctx.createOscillator();
      lfoX.frequency.value = 0.1;
      lfoZ.frequency.value = 0.1;
      lfoZ.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])));
      const depthX = ctx.createGain();
      const depthZ = ctx.createGain();
      depthX.gain.value = radius;
      depthZ.gain.value = radius;
      panner.positionX.value = 0;
      panner.positionZ.value = 0;
      lfoX.connect(depthX).connect(panner.positionX);
      lfoZ.connect(depthZ).connect(panner.positionZ);
      lfoX.start();
      lfoZ.start();

      this.spatialWet = ctx.createGain();
      this.spatialWet.gain.value = 0;
      this.analyserNode.connect(panner);
      panner.connect(this.spatialWet);
      this.spatialWet.connect(this.fadeGain);
      this.spatialPanner = panner;
      this._spatialFed = true;
      return true;
    }

    _applySpatial(amount) {
      const a = Math.max(0, Math.min(1, Number(amount) || 0));
      if (a > 0) this._ensureSpatialPath();
      if (!this.spatialDry || !this.ctx) return;
      const now = this.ctx.currentTime;
      this.spatialDry.gain.setTargetAtTime(1 - a, now, 0.05);
      // HRTF loses some level at distance; a little make-up keeps 8D as loud as the dry signal.
      if (this.spatialWet) this.spatialWet.gain.setTargetAtTime(a * 1.6, now, 0.05);
      // The HRTF panner is one of the most expensive nodes there is. Once 8D was tried it used to keep rendering
      // (at volume 0) for the rest of the session; now it is unplugged once 8D has faded out, and plugged back in
      // when 8D comes back.
      clearTimeout(this._spatialUnplugTimer);
      this._spatialAmount = a;
      if (!this.spatialPanner) return;
      if (a > 0 && !this._spatialFed) {
        try { this.analyserNode.connect(this.spatialPanner); this._spatialFed = true; } catch (_) {}
      } else if (a === 0 && this._spatialFed) {
        this._spatialUnplugTimer = setTimeout(() => {
          if (this._spatialAmount > 0 || !this._spatialFed) return;
          try { this.analyserNode.disconnect(this.spatialPanner); } catch (_) {}
          this._spatialFed = false;
        }, 400);
      }
    }

    _applyMasterVolume() {
      if (this.fadeGain && this.ctx) {
        try {
          if (this.fadeGain.gain.value <= 0.01) {
            this.fadeGain.gain.cancelScheduledValues(this.ctx.currentTime);
            this.fadeGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
          }
        } catch (_) {}
      }
      const raw = this.isMuted ? 0 : Math.max(0, Math.min(1, Number.isFinite(this.volume) ? this.volume : 0.85));
      const vol = raw * raw;
      const routed = !!(this.graphInitialized && this.userGain);
      const elementVol = routed ? 1 : vol;
      this.appliedElementVolume = elementVol;
      if (this.userGain && this.ctx) {
        try {
          const g = this.userGain.gain;
          g.cancelScheduledValues(this.ctx.currentTime);
          g.setTargetAtTime(raw === 0 ? 0 : vol, this.ctx.currentTime, 0.015);
        } catch (_) {}
      }
      if (this._attachedElement) {
        try {
          this._attachedElement.volume = elementVol;
          this._attachedElement.muted = this.graphInitialized ? false : !!this.isMuted;
        } catch (_) {}
      }
      if (this.masterGain) {
        const target = this.isMuted ? 0 : (Number.isFinite(this.audioSettings.volume) ? this.audioSettings.volume : 1.0);
        // An end-of-song fade-out keeps running; anything else is replaced right away.
        if (this.isFadingOut()) return;
        this._fadeOutUntil = 0;
        // During a fade-in, aim the rest of the ramp at the new level instead of jumping to it.
        const left = this.ctx && this._fadeInUntil ? this._fadeInUntil - this.ctx.currentTime : 0;
        if (left > 0.05) {
          if (this._fadeInTarget !== target) { this._fadeInTarget = target; this.safeRampParam(this.masterGain.gain, target, left, 1.0); }
        }
        else this.setParamNow(this.masterGain.gain, target, 1.0);
      }
    }

    // Set an AudioParam now, dropping anything scheduled on it. A bare `.value =` is ignored while a ramp is
    // pending and throws during setValueCurveAtTime, which left the volume stuck at 0.
    setParamNow(param, value, fallback = 1.0) {
      if (!param || !this.ctx) return;
      const v = Number.isFinite(value) ? value : fallback;
      const now = this.ctx.currentTime;
      try {
        param.cancelScheduledValues(now);
        param.setValueAtTime(v, now);
      } catch (_) {
        try { param.value = v; } catch (__) {}
      }
    }

    // Cancel, anchor the current value, then a linear ramp: safe to call again at any moment.
    // `from` sets the start level; without it the ramp starts where the param is now.
    safeRampParam(param, target, duration, fallback = 1.0, from = null) {
      if (!param || !this.ctx) return;
      const v = Number.isFinite(target) ? target : fallback;
      const now = this.ctx.currentTime;
      const d = Number.isFinite(duration) && duration > 0 ? duration : 0.01;
      try {
        if (Number.isFinite(from)) {
          param.cancelScheduledValues(now);
          param.setValueAtTime(from, now);
        } else if (typeof param.cancelAndHoldAtTime === 'function') {
          // Holds the level the audio thread is really at; `.value` can lag a change made moments ago.
          param.cancelAndHoldAtTime(now);
        } else {
          const cur = Number.isFinite(param.value) ? param.value : fallback;
          param.cancelScheduledValues(now);
          param.setValueAtTime(cur, now);
        }
        param.linearRampToValueAtTime(v, now + d);
      } catch (_) {
        this.setParamNow(param, v, fallback);
      }
    }

    isFading() {
      return this.isFadingOut() || !!(this.ctx && this._fadeInUntil && this.ctx.currentTime < this._fadeInUntil + 0.5);
    }

    isFadingOut() {
      return !!(this.ctx && this._fadeOutUntil && this.ctx.currentTime < this._fadeOutUntil + 0.5);
    }

    // Playback started or resumed: undo any leftover pause fade and make sure the context is running.
    ensureAudible() {
      if (!this.ctx) return;
      if (this.fadeGain && this.fadeGain.gain.value < 0.999) this.setParamNow(this.fadeGain.gain, 1.0, 1.0);
      if (this.normGain && !(this.normGain.gain.value >= 0.3)) this.setParamNow(this.normGain.gain, 1.0, 1.0);
      this.resumeAudioContext();
    }

    isModified() {
      const s = this.audioSettings;
      const eqMod = s.eq ? (s.eq.low !== 0 || s.eq.mid !== 0 || s.eq.high !== 0) : false;
      const eqBandsMod = Array.isArray(s.eqBands) ? s.eqBands.some(v => v !== 0) : false;
      return s.speed !== 1.0 || s.speedPitch !== 1.0 || s.pitch !== 0 ||
        s.reverb !== 0 || s.distortion !== 0 || s.volume !== 1.0 || s.echo !== 0 || (s.spatial8d || 0) > 0 || !!s.signature || eqMod || eqBandsMod;
    }


    fadeOut(durationSec = 0.25) {
      if (this.masterGain && this.ctx) {
        const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0.25;
        this._fadeOutUntil = this.ctx.currentTime + d;
        this._fadeInUntil = 0;
        this.safeRampParam(this.masterGain.gain, 0, d, 0);
      }
    }

    // Cancels a running fade-out, starting from wherever the volume is now.
    fadeIn(durationSec = 0.35, fromZero = false) {
      if (this.masterGain && this.ctx) {
        this._fadeOutUntil = 0;
        this._fadeInUntil = this.ctx.currentTime + (Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0.35);
        const vol = Number.isFinite(this.audioSettings.volume) ? this.audioSettings.volume : 1.0;
        this._fadeInTarget = this.isMuted ? 0 : vol;
        this.safeRampParam(this.masterGain.gain, this._fadeInTarget, durationSec, 1.0, fromZero ? 0 : null);
      }
    }


    getAnalyserNode() {
      return this.analyserNode;
    }

    setAnalyserEnabled(enabled) {
      this._analyserConnected = !!enabled;
    }

    suspendAudioContextDebounced(delayMs = 5000) {
      if (this._suspendTimer) clearTimeout(this._suspendTimer);
      this._suspendTimer = setTimeout(() => {
        this._suspendTimer = null;
        const el = this._attachedElement;
        if (el && !el.paused) return;
        if (this.ctx && this.ctx.state === 'running') {
          this._suspendPending = true;
          this.ctx.suspend().catch(() => {}).finally(() => {
            this._suspendPending = false;
            // Playback started while it was going to sleep: wake it straight back up.
            if (this._attachedElement && !this._attachedElement.paused) this.resumeAudioContext();
          });
        }
      }, delayMs);
    }

    resumeAudioContext() {
      if (this._suspendTimer) {
        clearTimeout(this._suspendTimer);
        this._suspendTimer = null;
      }
      if (this.ctx && (this.ctx.state !== 'running' || this._suspendPending) && this.ctx.state !== 'closed') {
        return this.ctx.resume().catch(() => {});
      }
    }

    setHidden(hidden) {
      if (this.analyserNode) {
        this.analyserNode.fftSize = hidden ? 32 : 128;
      }
      if (hidden) this.setAnalyserEnabled(false);
    }

    getFrequencyData(buffer) {
      if (!this._analyserConnected) this.setAnalyserEnabled(true);
      if (this.analyserNode) this.analyserNode.getByteFrequencyData(buffer);
    }

    getTimeDomainData(buffer) {
      if (!this._analyserConnected) this.setAnalyserEnabled(true);
      if (this.analyserNode) this.analyserNode.getByteTimeDomainData(buffer);
    }

    getLevelDb() {
      if (!this.levelAnalyser) return -120;
      this.levelAnalyser.getFloatTimeDomainData(this.levelBuf);
      let sum = 0;
      for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] * this.levelBuf[i];
      const rms = Math.sqrt(sum / this.levelBuf.length);
      return rms > 0 ? 20 * Math.log10(rms) : -120;
    }

    setNormalizeGainDb(db) {
      if (!this.normGain || !this.ctx) return;
      const raw = Math.pow(10, Number(db) / 20);
      const safe = Number.isFinite(raw) ? Math.min(3.0, Math.max(0.5, raw)) : 1.0;
      try {
        this.normGain.gain.setTargetAtTime(safe, this.ctx.currentTime, 0.4);
      } catch (_) {
        this.setParamNow(this.normGain.gain, safe, 1.0);
      }
    }


    isLiveStream(audioElement) {
      if (!audioElement) return false;
      const dur = audioElement.duration;
      return !isFinite(dur) || isNaN(dur);
    }


    async renderOffline(sourceBuffer, settingsOverride, hqOverride) {
      const s = settingsOverride || { ...this.audioSettings };
      const hq = hqOverride || { ...this.hqSettings };
      const useHq = this.hqEnabled;

      const speedFactor = (s.speedPitch !== 1.0 || s.pitch !== 0)
        ? s.speedPitch * Math.pow(2, s.pitch / 12)
        : s.speed;
      const outputLength = Math.ceil(sourceBuffer.length / Math.max(0.1, speedFactor));

      const offline = new OfflineAudioContext(
        sourceBuffer.numberOfChannels,
        outputLength,
        sourceBuffer.sampleRate
      );

      const src = offline.createBufferSource();
      src.buffer = sourceBuffer;
      src.playbackRate.value = speedFactor;

      const eqL = offline.createBiquadFilter(); eqL.type = 'lowshelf'; eqL.frequency.value = 200; eqL.gain.value = Math.max(-12, Math.min(12, s.eq?.low || 0));
      const eqM = offline.createBiquadFilter(); eqM.type = 'peaking'; eqM.frequency.value = 1000; eqM.Q.value = 0.9; eqM.gain.value = Math.max(-12, Math.min(12, s.eq?.mid || 0));
      const eqH = offline.createBiquadFilter(); eqH.type = 'highshelf'; eqH.frequency.value = 4000; eqH.gain.value = Math.max(-12, Math.min(12, s.eq?.high || 0));
      eqL.connect(eqM); eqM.connect(eqH);

      let offlineEqTail = eqH;
      if (Array.isArray(s.eqBands)) {
        const freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
        const bands = freqs.map((f, i) => {
          const filter = offline.createBiquadFilter();
          filter.type = 'peaking';
          filter.frequency.value = f;
          filter.Q.value = 1.1;
          filter.gain.value = Math.max(-12, Math.min(12, s.eqBands[i] || 0));
          return filter;
        });
        offlineEqTail.connect(bands[0]);
        for (let i = 0; i < bands.length - 1; i++) {
          bands[i].connect(bands[i + 1]);
        }
        offlineEqTail = bands[bands.length - 1];
      }

      if (useHq) {
        const comp = offline.createDynamicsCompressor();
        comp.threshold.value = -12;
        comp.knee.value = 10;
        comp.ratio.value = hq.engine === 'fyro1.1' ? 2.0 : 1.5;
        comp.attack.value = 0.01;
        comp.release.value = 0.1;

        const bass = offline.createBiquadFilter();
        bass.type = 'lowshelf';
        bass.frequency.value = 80;
        const baseBass = hq.engine === 'fyro1.1' ? 3.0 : 0;
        bass.gain.value = Math.max(-4, Math.min(4, baseBass + (hq.bass * 0.08)));

        const vocal = offline.createBiquadFilter();
        vocal.type = 'peaking';
        vocal.frequency.value = 2500;
        vocal.Q.value = 1.2;
        vocal.gain.value = Math.max(-4, Math.min(4, hq.vocal * 0.08));

        const air = offline.createBiquadFilter();
        air.type = 'highshelf';
        air.frequency.value = 9000;
        const baseAir = hq.engine === 'glyphs-7B' ? 2.5 : 0;
        air.gain.value = Math.max(-4, Math.min(4, baseAir + (hq.air * 0.08)));

        const sat = offline.createWaveShaper();
        sat.oversample = '4x';
        const satAmount = hq.engine === 'hqmusic-3' ? 0.5 : 0.2;
        sat.curve = this._makeHarmonicCurve(satAmount);

        const limiter = offline.createDynamicsCompressor();
        limiter.threshold.value = -1;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.005;
        limiter.release.value = 0.05;

        const master = offline.createGain();
        master.gain.value = s.volume;

        src.connect(comp);
        comp.connect(bass);
        bass.connect(vocal);
        vocal.connect(air);
        air.connect(sat);
        sat.connect(limiter);
        limiter.connect(eqL);
        offlineEqTail.connect(master);
        this._connectOfflineOutput(offline, master, s);

      } else {
        const dry = offline.createGain();
        const distNode = offline.createWaveShaper();
        distNode.oversample = 'none';
        const distGain = offline.createGain();
        const delay = offline.createDelay(1.0);
        delay.delayTime.value = 0.3;
        const feedback = offline.createGain();
        feedback.gain.value = 0.35;
        const echoGain = offline.createGain();
        const conv = offline.createConvolver();
        conv.buffer = this._createReverbImpulse(offline);
        const revGain = offline.createGain();
        const master = offline.createGain();

        revGain.gain.value = s.reverb / 100;
        echoGain.gain.value = s.echo / 100;

        if (s.distortion > 0) {
          distNode.curve = this._makeDistortionCurve(s.distortion);
          distGain.gain.value = (s.distortion / 100) * 0.75;
          dry.gain.value = 1.0 - (s.distortion / 100) * 0.4;
        } else {
          distNode.curve = this._makeDistortionCurve(0);
          distGain.gain.value = 0.0;
          dry.gain.value = 1.0;
        }

        master.gain.value = s.volume;

        src.connect(eqL);

        delay.connect(feedback);
        feedback.connect(delay);

        offlineEqTail.connect(dry);
        dry.connect(master);

        offlineEqTail.connect(distNode);
        distNode.connect(distGain);
        distGain.connect(master);

        offlineEqTail.connect(delay);
        delay.connect(echoGain);
        echoGain.connect(master);

        offlineEqTail.connect(conv);
        conv.connect(revGain);
        revGain.connect(master);

        this._connectOfflineOutput(offline, master, s);
      }

      src.start(0);
      return offline.startRendering();
    }

    // Same 8D orbit as live playback, so a downloaded "8D Audio" version sounds like what you heard.
    _connectOfflineOutput(offline, master, s) {
      const a = Math.max(0, Math.min(1, Number(s && s.spatial8d) || 0));
      if (a <= 0) {
        master.connect(offline.destination);
        return;
      }
      const dry = offline.createGain();
      dry.gain.value = 1 - a;
      master.connect(dry).connect(offline.destination);

      const panner = offline.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      const lfoX = offline.createOscillator();
      const lfoZ = offline.createOscillator();
      lfoX.frequency.value = 0.1;
      lfoZ.frequency.value = 0.1;
      lfoZ.setPeriodicWave(offline.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])));
      const depthX = offline.createGain();
      const depthZ = offline.createGain();
      depthX.gain.value = 2.2;
      depthZ.gain.value = 2.2;
      panner.positionX.value = 0;
      panner.positionZ.value = 0;
      lfoX.connect(depthX).connect(panner.positionX);
      lfoZ.connect(depthZ).connect(panner.positionZ);
      lfoX.start(0);
      lfoZ.start(0);

      const wet = offline.createGain();
      wet.gain.value = a * 1.6;
      master.connect(panner);
      panner.connect(wet).connect(offline.destination);
    }

    audioBufferToWav(buffer) {
      const numChannels = buffer.numberOfChannels;
      const sampleRate = buffer.sampleRate;
      const bitDepth = 16;

      const channels = [];
      for (let i = 0; i < numChannels; i++) {
        channels.push(buffer.getChannelData(i));
      }

      const length = channels[0].length;
      const bytesPerSample = bitDepth / 8;
      const blockAlign = numChannels * bytesPerSample;
      const dataSize = length * blockAlign;
      const headerSize = 44;
      const totalSize = headerSize + dataSize;

      const arrayBuffer = new ArrayBuffer(totalSize);
      const view = new DataView(arrayBuffer);

      const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) {
          view.setUint8(offset + i, str.charCodeAt(i));
        }
      };

      writeString(0, 'RIFF');
      view.setUint32(4, totalSize - 8, true);
      writeString(8, 'WAVE');

      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * blockAlign, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, bitDepth, true);

      writeString(36, 'data');
      view.setUint32(40, dataSize, true);

      let offset = 44;
      for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          const sample = Math.max(-1, Math.min(1, channels[ch][i]));
          view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
          offset += 2;
        }
      }

      return new Blob([arrayBuffer], { type: 'audio/wav' });
    }
  }

  global.RiffAudioEngine = RiffAudioEngine;

})(typeof window !== 'undefined' ? window : globalThis);
