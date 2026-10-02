/* MusikSparring — Web Audio engine (browser global `AudioKit`). Single shared AudioContext.
 * Side effects: creates an AudioContext lazily on first user gesture; emits sound. */
(function (root) {
  'use strict';

  const T = root.Theory;

  let ctx = null;
  let master = null;
  let noiseBuffer = null;

  function ensure() {
    if (ctx) return ctx;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(comp);
    comp.connect(ctx.destination);
    return ctx;
  }

  async function resume() {
    const c = ensure();
    if (!c) return null;
    if (c.state === 'suspended') {
      try {
        await c.resume();
      } catch {
        /* user gesture required; ignore */
      }
    }
    return c;
  }

  const now = () => (ctx ? ctx.currentTime : 0);

  function getNoise() {
    if (noiseBuffer) return noiseBuffer;
    const len = ctx.sampleRate;
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  /** Piano-ish tone: two detuned oscillators + octave partial through a lowpass with ADSR. */
  function tone(freq, when, opts = {}) {
    const c = ensure();
    if (!c) return;
    const dur = opts.duration ?? 0.8;
    const vel = opts.velocity ?? 0.5;
    const t0 = Math.max(when, c.currentTime);

    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(vel, t0 + 0.012);
    env.gain.exponentialRampToValueAtTime(vel * 0.55, t0 + 0.18);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(freq * 6, 8000), t0);
    lp.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.5, 300), t0 + dur);
    lp.Q.value = 0.7;

    const partials = [
      { type: 'triangle', mult: 1, gain: 1, detune: 0 },
      { type: 'sine', mult: 1, gain: 0.5, detune: 6 },
      { type: 'sine', mult: 2, gain: 0.18, detune: 0 },
    ];
    for (const p of partials) {
      const o = c.createOscillator();
      o.type = p.type;
      o.frequency.value = freq * p.mult;
      o.detune.value = p.detune;
      const g = c.createGain();
      g.gain.value = p.gain;
      o.connect(g);
      g.connect(lp);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    }
    lp.connect(env);
    env.connect(master);
  }

  async function playNote(note, octave = 4, opts = {}) {
    const c = await resume();
    if (!c) return;
    tone(T.freq(note, octave), c.currentTime + (opts.delay || 0), opts);
  }

  /** @param {{note:string, octave:number}[]} voicing */
  async function playChord(voicing, opts = {}) {
    const c = await resume();
    if (!c) return;
    const strum = opts.strum ?? 0.035;
    const start = c.currentTime + (opts.delay || 0);
    voicing.forEach((v, i) => tone(T.freq(v.note, v.octave), start + i * strum, {
      duration: opts.duration ?? 1.8, velocity: (opts.velocity ?? 0.42) / Math.sqrt(voicing.length) * 1.6,
    }));
  }

  async function playSequence(notes, opts = {}) {
    const c = await resume();
    if (!c) return;
    const gap = opts.gap ?? 0.22;
    notes.forEach((n, i) => tone(T.freq(n.note, n.octave), c.currentTime + i * gap, {
      duration: opts.duration ?? 0.5, velocity: opts.velocity ?? 0.45,
    }));
  }

  function drum(type, when, velocity = 1) {
    const c = ensure();
    if (!c) return;
    const t0 = Math.max(when, c.currentTime);
    const out = c.createGain();
    out.connect(master);

    if (type === 'kick') {
      const o = c.createOscillator();
      o.frequency.setValueAtTime(160, t0);
      o.frequency.exponentialRampToValueAtTime(45, t0 + 0.12);
      out.gain.setValueAtTime(1.1 * velocity, t0);
      out.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
      o.connect(out);
      o.start(t0);
      o.stop(t0 + 0.5);
      const click = c.createBufferSource();
      click.buffer = getNoise();
      const cg = c.createGain();
      cg.gain.setValueAtTime(0.25 * velocity, t0);
      cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.02);
      click.connect(cg);
      cg.connect(master);
      click.start(t0);
      click.stop(t0 + 0.03);
      return;
    }
    if (type === 'snare') {
      const n = c.createBufferSource();
      n.buffer = getNoise();
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 0.8;
      out.gain.setValueAtTime(0.7 * velocity, t0);
      out.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
      n.connect(bp);
      bp.connect(out);
      n.start(t0);
      n.stop(t0 + 0.25);
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(220, t0);
      o.frequency.exponentialRampToValueAtTime(120, t0 + 0.08);
      const og = c.createGain();
      og.gain.setValueAtTime(0.5 * velocity, t0);
      og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
      o.connect(og);
      og.connect(master);
      o.start(t0);
      o.stop(t0 + 0.15);
      return;
    }
    if (type === 'hihat' || type === 'openhat') {
      const n = c.createBufferSource();
      n.buffer = getNoise();
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7000;
      const len = type === 'openhat' ? 0.35 : 0.06;
      out.gain.setValueAtTime(0.35 * velocity, t0);
      out.gain.exponentialRampToValueAtTime(0.001, t0 + len);
      n.connect(hp);
      hp.connect(out);
      n.start(t0);
      n.stop(t0 + len + 0.02);
      return;
    }
    if (type === 'clap') {
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1200;
      bp.Q.value = 1.2;
      bp.connect(out);
      out.gain.value = 0.6 * velocity;
      [0, 0.012, 0.024, 0.04].forEach((off, i) => {
        const n = c.createBufferSource();
        n.buffer = getNoise();
        const g = c.createGain();
        g.gain.setValueAtTime(i === 3 ? 1 : 0.6, t0 + off);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + off + (i === 3 ? 0.18 : 0.012));
        n.connect(g);
        g.connect(bp);
        n.start(t0 + off);
        n.stop(t0 + off + 0.2);
      });
    }
  }

  async function playDrum(type, velocity = 1) {
    const c = await resume();
    if (!c) return;
    drum(type, c.currentTime, velocity);
  }

  /**
   * Lookahead step sequencer. onStep(stepIndex, audioTime) is called ahead of time;
   * onVisual(stepIndex) fires roughly when the step is audible.
   */
  function createSequencer({ steps = 16, bpm = 120, swing = 0, onStep, onVisual }) {
    const LOOKAHEAD = 0.12;
    const TICK = 25;
    let timer = null;
    let step = 0;
    let nextTime = 0;
    let visualTimers = [];
    const state = { bpm, swing, running: false };

    function stepLength(i) {
      const base = 60 / state.bpm / 4;
      const s = Math.max(0, Math.min(0.5, state.swing));
      return i % 2 === 0 ? base * (1 + s) : base * (1 - s);
    }

    function tick() {
      while (nextTime < ctx.currentTime + LOOKAHEAD) {
        const i = step;
        const t = nextTime;
        onStep(i, t);
        if (onVisual) {
          const h = setTimeout(() => onVisual(i), Math.max(0, (t - ctx.currentTime) * 1000));
          visualTimers.push(h);
          if (visualTimers.length > 64) visualTimers = visualTimers.slice(-32);
        }
        nextTime += stepLength(i);
        step = (step + 1) % steps;
      }
    }

    return {
      state,
      async start() {
        const c = await resume();
        if (!c || state.running) return;
        state.running = true;
        step = 0;
        nextTime = c.currentTime + 0.05;
        timer = setInterval(tick, TICK);
        tick();
      },
      stop() {
        state.running = false;
        if (timer) clearInterval(timer);
        timer = null;
        visualTimers.forEach(clearTimeout);
        visualTimers = [];
        if (onVisual) onVisual(-1);
      },
      setBpm(v) { state.bpm = v; },
      setSwing(v) { state.swing = v; },
    };
  }

  root.AudioKit = Object.freeze({
    ensure, resume, now, playNote, playChord, playSequence, drum, playDrum, createSequencer,
    get context() { return ctx; },
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
