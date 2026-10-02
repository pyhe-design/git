/* MusikSparring Pro v3 — UI (Preact + htm, no build step).
 * Globals expected: preact, preactHooks, htm, MusikAI, Theory, AudioKit. */
(function () {
  'use strict';

  const { h, render, Fragment } = window.preact;
  const { useState, useEffect, useRef, useCallback, useMemo } = window.preactHooks;
  const html = window.htm.bind(h);
  const T = window.Theory;
  const A = window.AudioKit;
  const AI = window.MusikAI;

  // ---------------------------------------------------------------------------
  // Storage (side effect: localStorage on this device only)
  // ---------------------------------------------------------------------------
  const KEYS = { params: 'ms3.params', settings: 'ms3.settings', history: 'ms3.history', tab: 'ms3.tab' };
  const store = {
    get(k, fallback) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* quota / private mode */
      }
    },
    raw(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
  };

  const EMPTY_PARAMS = { genre: '', mood: '', bpm: '', key: '', references: '', existing: '', constraints: '', goals: '' };
  const DEFAULT_SETTINGS = { provider: 'demo', temperature: 0.8, configs: {} };

  function loadSettings() {
    const s = store.get(KEYS.settings, null);
    if (s) return { ...DEFAULT_SETTINGS, ...s, configs: s.configs || {} };
    // Migrate v2 keys.
    const legacyKey = store.raw('musiksparring_api_key');
    const legacyProvider = store.raw('musiksparring_provider');
    if (legacyKey) {
      const provider = legacyProvider === 'openai' ? 'openai' : 'anthropic';
      return { ...DEFAULT_SETTINGS, provider, configs: { [provider]: { apiKey: legacyKey } } };
    }
    return { ...DEFAULT_SETTINGS };
  }

  function loadParams() {
    const p = store.get(KEYS.params, null) || store.get('musiksparring_params', null) || {};
    return { ...EMPTY_PARAMS, ...p };
  }

  function activeConfig(settings) {
    const meta = AI.PROVIDERS[settings.provider] || AI.PROVIDERS.demo;
    const c = settings.configs[meta.id] || {};
    return {
      provider: meta.id,
      baseUrl: c.baseUrl || meta.baseUrl,
      model: c.model || meta.defaultModel,
      apiKey: c.apiKey || '',
      temperature: settings.temperature,
    };
  }

  // ---------------------------------------------------------------------------
  // Icons
  // ---------------------------------------------------------------------------
  const ICONS = {
    edit: ['M12 20h9', 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'],
    sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
    sparkles: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z', 'M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8L19 17z'],
    clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
    settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'],
    play: ['M6 4l14 8-14 8V4z'],
    stop: ['M6 6h12v12H6z'],
    copy: ['M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
    download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
    trash: ['M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'],
    check: ['M20 6L9 17l-5-5'],
    x: ['M18 6L6 18', 'M6 6l12 12'],
    alert: ['M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
    info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
    music: ['M9 18V5l12-2v13', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
    zap: ['M13 2L3 14h9l-1 8 10-12h-9l1-8z'],
    refresh: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.5 9a9 9 0 0 1 14.9-3.4L23 10', 'M1 14l4.6 4.4A9 9 0 0 0 20.5 15'],
    activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
    mic: ['M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v4', 'M8 23h8'],
    layers: ['M12 2L2 7l10 5 10-5-10-5z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5'],
    disc: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
    help: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
    feather: ['M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z', 'M16 8L2 22', 'M17.5 15H9'],
    compass: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z'],
    shuffle: ['M16 3h5v5', 'M4 20L21 3', 'M21 16v5h-5', 'M15 15l6 6', 'M4 4l5 5'],
    arrow: ['M5 12h14', 'M12 5l7 7-7 7'],
    target: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z', 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  };
  const Icon = ({ name, size = 18, fill = false }) => html`
    <svg width=${size} height=${size} viewBox="0 0 24 24" fill=${fill ? 'currentColor' : 'none'} stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${(ICONS[name] || []).map((d) => html`<path d=${d} />`)}
    </svg>`;

  // ---------------------------------------------------------------------------
  // Small shared components
  // ---------------------------------------------------------------------------
  const Toasts = ({ items }) => html`
    <div class="toasts" role="status" aria-live="polite">
      ${items.map((t) => html`<div key=${t.id} class=${'toast ' + t.kind}>
        <${Icon} name=${t.kind === 'ok' ? 'check' : t.kind === 'err' ? 'alert' : 'info'} size=${16} />
        <div>${t.text}</div>
      </div>`)}
    </div>`;

  const Chips = ({ options, value, onPick, color = '' }) => html`
    <div class="chips">
      ${options.map((o) => html`<button type="button" key=${o}
        class=${'chip ' + color + (String(value || '').toLowerCase() === o.toLowerCase() ? ' is-on' : '')}
        onClick=${() => onPick(o)}>${o}</button>`)}
    </div>`;

  // ---------------------------------------------------------------------------
  // Piano (2 octaves)
  // ---------------------------------------------------------------------------
  const WHITE = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const BLACK = { 'C#': 1, 'D#': 2, 'F#': 4, 'G#': 5, 'A#': 6 };
  const KEY_W = 45; // 44px + 1px gap

  function Piano({ octaves = 2, startOctave = 4, scale, chord, root, chordMidis, onPlay }) {
    const [playing, setPlaying] = useState(null);
    const play = (note, oct) => {
      setPlaying(`${note}${oct}`);
      setTimeout(() => setPlaying(null), 260);
      A.playNote(note, oct, { duration: 0.9, velocity: 0.5 });
      if (onPlay) onPlay(note, oct);
    };
    const cls = (note, oct, base) => {
      const m = T.midi(note, oct);
      const inChord = chordMidis ? chordMidis.has(m) : chord && chord.has(note);
      return [
        'key', base,
        scale && scale.has(note) ? 'is-scale' : '',
        inChord ? 'is-chord' : '',
        root && note === root && (inChord || !chordMidis) && (scale || inChord) ? 'is-root' : '',
        playing === `${note}${oct}` ? 'is-playing' : '',
      ].join(' ');
    };
    const keys = [];
    for (let o = 0; o < octaves; o++) {
      const oct = startOctave + o;
      WHITE.forEach((n) => keys.push(html`<button type="button" key=${n + oct} class=${cls(n, oct, 'white')}
        aria-label=${`Spil ${n}${oct}`} onClick=${() => play(n, oct)}>
        <span class="key-label">${n}${n === 'C' ? oct : ''}</span></button>`));
    }
    const blacks = [];
    for (let o = 0; o < octaves; o++) {
      const oct = startOctave + o;
      Object.entries(BLACK).forEach(([n, pos]) => blacks.push(html`<button type="button" key=${n + oct}
        class=${cls(n, oct, 'black')} style=${{ left: `${(o * 7 + pos) * KEY_W}px` }}
        aria-label=${`Spil ${n}${oct}`} onClick=${() => play(n, oct)}>
        <span class="key-label">${n}</span></button>`));
    }
    return html`<div class="piano-wrap"><div class="piano" role="group" aria-label="Klaviatur">${keys}${blacks}</div></div>`;
  }

  // ---------------------------------------------------------------------------
  // Fretboard (SVG). mode 'scale' → tone map over 12 frets; mode 'chord' → shape window.
  // ---------------------------------------------------------------------------
  function Fretboard({ mode, notes, root, shape }) {
    const strings = 6;
    const fretCount = mode === 'chord' ? 5 : 12;
    const base = mode === 'chord' && shape ? shape.base : 0;
    const origin = base > 0 ? base - 1 : 0; // fret wire at the left edge of the board
    const left = 34;
    const top = 18;
    const fretW = mode === 'chord' ? 64 : 40;
    const stringGap = 22;
    const width = left + fretW * fretCount + 20;
    const height = top + stringGap * (strings - 1) + 34;
    const fretX = (f) => left + (f - origin) * fretW; // position of fret wire f
    const posX = (f) => (f === 0 ? left - 14 : fretX(f) - fretW / 2);
    const stringY = (sIdx) => top + (strings - 1 - sIdx) * stringGap; // sIdx 0 = low E (bottom)
    const inlays = [3, 5, 7, 9, 12, 15];
    const dots = [];
    const extras = [];

    if (mode === 'chord' && shape) {
      shape.frets.forEach((f, sIdx) => {
        if (f < 0) {
          extras.push(html`<text key=${'x' + sIdx} class="fb-muted" x=${left - 14} y=${stringY(sIdx) + 4}>×</text>`);
          return;
        }
        const note = T.fretNote(sIdx, f);
        const isRoot = note === shape.root;
        dots.push(html`<g key=${'d' + sIdx}>
          <circle class=${'fb-dot' + (isRoot ? ' root' : '')} cx=${posX(f)} cy=${stringY(sIdx)} r="9" />
          <text class="fb-dot-label" x=${posX(f)} y=${stringY(sIdx) + 3}>${note}</text></g>`);
      });
      if (shape.barre) {
        const barreFret = Math.min(...shape.frets.filter((f) => f > 0));
        const barred = shape.frets.map((f, i) => (f === barreFret ? i : -1)).filter((i) => i >= 0);
        if (barred.length >= 2) {
          const lo = Math.min(...barred);
          const hi = Math.max(...barred);
          extras.unshift(html`<rect key="barre" class="fb-barre" x=${posX(barreFret) - 9} y=${stringY(hi) - 9}
            width="18" height=${stringY(lo) - stringY(hi) + 18} rx="9" />`);
        }
      }
    } else if (notes) {
      for (let s = 0; s < strings; s++) {
        for (let f = 0; f <= fretCount; f++) {
          const note = T.fretNote(s, f);
          if (!notes.has(note)) continue;
          dots.push(html`<g key=${`${s}-${f}`}>
            <circle class=${'fb-dot' + (note === root ? ' root' : '')} cx=${posX(f)} cy=${stringY(s)} r="8" />
            <text class="fb-dot-label" x=${posX(f)} y=${stringY(s) + 3}>${note}</text></g>`);
        }
      }
    }

    const lastFret = origin + fretCount;
    const fretWires = [];
    for (let f = origin + 1; f <= lastFret; f++) {
      fretWires.push(html`<line key=${'f' + f} class="fb-fret" x1=${fretX(f)} x2=${fretX(f)} y1=${top - 4} y2=${stringY(0) + 4} />`);
    }
    const inlayDots = inlays.filter((f) => f > origin && f <= lastFret).map((f) => html`
      <circle key=${'i' + f} class="fb-inlay" cx=${posX(f)} cy=${(stringY(0) + stringY(5)) / 2} r=${f % 12 === 0 ? 6 : 4.5} />`);
    const labels = [];
    for (let f = origin + 1; f <= lastFret; f++) {
      if (mode === 'chord' || inlays.includes(f) || f === 1) {
        labels.push(html`<text key=${'l' + f} class="fb-label" x=${posX(f)} y=${height - 8}>${f}</text>`);
      }
    }
    const boardX = origin === 0 ? left : fretX(origin);

    return html`<svg class="fretboard" viewBox=${`0 0 ${width} ${height}`} role="img" aria-label="Gribebræt">
      <defs><linearGradient id="wood" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#2a2420" /><stop offset="1" stop-color="#171311" /></linearGradient></defs>
      <rect class="fb-board" x=${boardX} y=${top - 10} width=${width - boardX - 20} height=${stringY(0) - top + 20} rx="4" />
      ${origin === 0 ? html`<rect class="fb-nut" x=${left - 4} y=${top - 10} width="5" height=${stringY(0) - top + 20} rx="1" />` : null}
      ${inlayDots}
      ${fretWires}
      ${Array.from({ length: strings }, (_, s) => html`<line key=${'s' + s} class="fb-string"
        x1=${left - 4} x2=${width - 20} y1=${stringY(s)} y2=${stringY(s)} style=${{ strokeWidth: 1 + (5 - s) * 0.35 }} />`)}
      ${extras}
      ${dots}
      ${labels}
    </svg>`;
  }

  // ---------------------------------------------------------------------------
  // Scale Lab
  // ---------------------------------------------------------------------------
  const SCALE_NAMES = Object.keys(T.SCALES);

  function triadsFromScale(notes) {
    if (notes.length !== 7) return [];
    return notes.map((n, i) => {
      const third = (T.noteIndex(notes[(i + 2) % 7]) - T.noteIndex(n) + 12) % 12;
      const fifth = (T.noteIndex(notes[(i + 4) % 7]) - T.noteIndex(n) + 12) % 12;
      const q = third === 4 && fifth === 7 ? '' : third === 3 && fifth === 7 ? 'm' : third === 3 && fifth === 6 ? 'dim' : third === 4 && fifth === 8 ? 'aug' : null;
      return q === null ? null : n + q;
    }).filter(Boolean);
  }

  function ScaleLab({ initialKey, onPickChord }) {
    const parsed = useMemo(() => T.parseKey(initialKey), [initialKey]);
    const [root, setRoot] = useState(parsed?.root || 'C');
    const [scale, setScale] = useState(parsed?.mode === 'minor' ? 'Mol (Æolisk)' : 'Dur (Ionisk)');
    const [showIntervals, setShowIntervals] = useState(false);
    useEffect(() => {
      if (parsed) {
        setRoot(parsed.root);
        setScale(parsed.mode === 'minor' ? 'Mol (Æolisk)' : 'Dur (Ionisk)');
      }
    }, [parsed]);

    const notes = useMemo(() => T.getScaleNotes(root, scale), [root, scale]);
    const names = T.SCALES[scale].names;
    const set = useMemo(() => new Set(notes), [notes]);
    const triads = useMemo(() => triadsFromScale(notes), [notes]);

    const playScale = () => {
      const seq = [];
      let oct = 4;
      let prev = -1;
      for (const n of notes) {
        const idx = T.noteIndex(n);
        if (idx < prev) oct += 1;
        prev = idx;
        seq.push({ note: n, octave: oct });
      }
      seq.push({ note: root, octave: oct + (T.noteIndex(root) <= prev ? 1 : 0) });
      A.playSequence(seq, { gap: 0.2, duration: 0.5 });
    };

    return html`<div class="card">
      <div class="card-head">
        <span class="section-icon teal"><${Icon} name="music" /></span>
        <div><div class="card-title">Scale Lab</div><div class="card-sub">Toner, intervaller og diatoniske akkorder</div></div>
        <div class="card-actions">
          <button class="btn btn-sm" onClick=${() => setShowIntervals(!showIntervals)}>${showIntervals ? 'Vis toner' : 'Vis intervaller'}</button>
          <button class="btn btn-sm btn-primary" onClick=${playScale}><${Icon} name="play" fill /> Afspil skala</button>
        </div>
      </div>
      <div class="grid-3" style="margin-bottom:16px">
        <label class="field"><span class="label">Grundtone</span>
          <select class="select" value=${root} onChange=${(e) => setRoot(e.target.value)}>
            ${T.NOTES.map((n, i) => html`<option key=${n} value=${n}>${n}${T.FLAT_NAMES[i] !== n ? ` / ${T.FLAT_NAMES[i]}` : ''}</option>`)}
          </select></label>
        <label class="field" style="grid-column: span 2"><span class="label">Skala / modus</span>
          <select class="select" value=${scale} onChange=${(e) => setScale(e.target.value)}>
            ${SCALE_NAMES.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}
          </select></label>
      </div>
      <div class="note-grid" style="margin-bottom:16px">
        ${notes.map((n, i) => html`<button type="button" key=${n} class=${'note-tile' + (i === 0 ? ' is-root' : '')}
          onClick=${() => A.playNote(n, i === 0 || T.noteIndex(n) > T.noteIndex(root) ? 4 : 5)}>
          <span>${showIntervals ? names[i] : n}</span><small>${showIntervals ? n : names[i]}</small></button>`)}
      </div>
      <${Piano} scale=${set} root=${root} />
      <div style="margin-top:14px"><${Fretboard} mode="scale" notes=${set} root=${root} /></div>
      ${triads.length ? html`<div style="margin-top:14px">
        <div class="label" style="margin-bottom:8px">Diatoniske akkorder <span class="hint">klik for at åbne i Chord Lab</span></div>
        <div class="prog-chords">${triads.map((c, i) => html`<button type="button" key=${c} class="chord-pill"
          onClick=${() => { onPickChord(c); A.playChord(T.chordVoicing(c, 4), { duration: 1.4 }); }}>
          <small class="muted" style="margin-right:6px">${i + 1}</small>${c}</button>`)}</div></div>` : null}
      <div class="legend" style="margin-top:14px">
        <span><i style="background:var(--teal)"></i>i skalaen</span>
        <span><i style="background:var(--accent)"></i>grundtone</span>
        <span>Klik på tangenter og felter for at høre tonen</span>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Chord Lab
  // ---------------------------------------------------------------------------
  function ChordLab({ chord, progression, bpm, onChord, compact = false, autoplay = 0 }) {
    const [input, setInput] = useState(chord || 'C');
    const [now, setNow] = useState(-1);
    const timers = useRef([]);
    const playRef = useRef(null);
    useEffect(() => { if (chord) setInput(chord); }, [chord]);
    useEffect(() => () => timers.current.forEach(clearTimeout), []);
    useEffect(() => { if (autoplay && playRef.current) playRef.current(); }, [autoplay]);

    const parsed = useMemo(() => T.parseChord(input), [input]);
    const voicing = useMemo(() => (parsed ? T.chordVoicing(parsed.symbol, 4) : []), [parsed]);
    const midis = useMemo(() => new Set(voicing.map((v) => v.midi)), [voicing]);
    const notesSet = useMemo(() => new Set(voicing.map((v) => v.note)), [voicing]);
    const shape = useMemo(() => (parsed ? T.guitarShape(parsed.symbol) : null), [parsed]);

    const stopProg = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      setNow(-1);
    };
    const playProg = async () => {
      if (!progression || !progression.length) return;
      stopProg();
      await A.resume();
      const beat = 60 / (Number(bpm) || 100);
      const bar = beat * 4;
      progression.forEach((c, i) => {
        A.playChord(T.chordVoicing(c, 4), { delay: i * bar, duration: bar * 0.95, strum: 0.04 });
        timers.current.push(setTimeout(() => { setNow(i); if (onChord) onChord(c); }, i * bar * 1000));
      });
      timers.current.push(setTimeout(() => setNow(-1), progression.length * bar * 1000));
    };
    playRef.current = playProg;

    return html`<div class=${compact ? '' : 'card'}>
      ${!compact ? html`<div class="card-head">
        <span class="section-icon"><${Icon} name="disc" /></span>
        <div><div class="card-title">Chord Lab</div><div class="card-sub">Voicing på klaver og guitar</div></div>
      </div>` : null}
      <div class="row" style="margin-bottom:14px">
        <label class="field" style="min-width:160px"><span class="label">Akkord</span>
          <input class=${'input mono' + (parsed ? '' : ' is-invalid')} value=${input} spellcheck="false"
            onInput=${(e) => { setInput(e.target.value); const p = T.parseChord(e.target.value); if (p && onChord) onChord(p.symbol); }}
            placeholder="fx F#m7, Bbmaj7, G/B" aria-label="Akkordsymbol" /></label>
        <div class="field"><span class="label">${'\u00a0'}</span>
          <div class="row">
            <button class="btn btn-primary" disabled=${!parsed} onClick=${() => A.playChord(voicing, { duration: 1.8 })}>
              <${Icon} name="play" fill /> Afspil akkord</button>
            ${progression && progression.length ? html`<button class="btn" onClick=${now >= 0 ? stopProg : playProg}>
              <${Icon} name=${now >= 0 ? 'stop' : 'play'} fill /> ${now >= 0 ? 'Stop' : 'Afspil progression'}</button>` : null}
          </div></div>
        ${parsed ? html`<div class="grow small muted" style="align-self:end">
          <b class="mono" style="color:var(--text)">${parsed.symbol}</b> · ${parsed.label} · toner: <span class="mono">${T.chordNotes(parsed.symbol).join(' ')}</span>
        </div>` : html`<div class="grow small" style="align-self:end;color:var(--danger)">Ukendt akkordsymbol</div>`}
      </div>
      ${progression && progression.length ? html`<div class="prog-chords" style="margin-bottom:14px">
        ${progression.map((c, i) => html`<${Fragment} key=${c + i}>
          <button type="button" class=${'chord-pill' + (now === i ? ' is-now' : parsed && parsed.symbol === T.parseChord(c)?.symbol ? ' is-active' : '')}
            onClick=${() => { setInput(c); if (onChord) onChord(c); A.playChord(T.chordVoicing(c, 4), { duration: 1.4 }); }}>${c}</button>
          ${i < progression.length - 1 ? html`<span class="chord-arrow">→</span>` : null}
        <//>`)}
      </div>` : null}
      <div class="grid-2">
        <div>
          <div class="label" style="margin-bottom:8px">Klaver</div>
          <${Piano} chordMidis=${midis} chord=${notesSet} root=${parsed?.root} />
        </div>
        <div>
          <div class="label" style="margin-bottom:8px">Guitar ${shape ? html`<span class="hint">${shape.barre ? `barré fra ${shape.base}. bånd` : 'åben stilling'}</span>` : html`<span class="hint">akkordtoner på gribebrættet</span>`}</div>
          <${Fretboard} mode=${shape ? 'chord' : 'scale'} shape=${shape} notes=${notesSet} root=${parsed?.root} />
        </div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Rhythm Lab (step sequencer)
  // ---------------------------------------------------------------------------
  const TRACKS = [
    { key: 'kick', name: 'Kick', color: '#ff7a1a' },
    { key: 'snare', name: 'Snare', color: '#ff4d6d' },
    { key: 'hihat', name: 'Hi-hat', color: '#2dd4bf' },
    { key: 'clap', name: 'Clap', color: '#8b7cff' },
  ];
  const S = (str) => str.split('').map((c) => c === 'x');
  const PRESETS = {
    'Basic rock': { kick: S('x...x...x...x...'), snare: S('....x.......x...'), hihat: S('x.x.x.x.x.x.x.x.'), clap: S('................') },
    'Four on the floor': { kick: S('x...x...x...x...'), snare: S('................'), hihat: S('..x...x...x...x.'), clap: S('....x.......x...') },
    Disco: { kick: S('x...x...x...x...'), snare: S('....x.......x...'), hihat: S('xxxxxxxxxxxxxxxx'), clap: S('....x.......x...') },
    Breakbeat: { kick: S('x.....x..x..x...'), snare: S('....x..x....x...'), hihat: S('.x.x.x.x.x.x.x.x'), clap: S('................') },
    Trap: { kick: S('x.....x...x.....'), snare: S('........x.......'), hihat: S('x.xxx.x.x.xxx.xx'), clap: S('........x.......') },
    'Lo-fi': { kick: S('x......x..x.....'), snare: S('....x.......x..x'), hihat: S('x.x.x.xxx.x.x.x.'), clap: S('................') },
    Reggaeton: { kick: S('x...x...x...x...'), snare: S('...x..x....x..x.'), hihat: S('x.x.x.x.x.x.x.x.'), clap: S('................') },
  };
  const emptyPattern = () => Object.fromEntries(TRACKS.map((t) => [t.key, Array(16).fill(false)]));

  function RhythmLab({ initialBpm }) {
    const [pattern, setPattern] = useState(() => PRESETS['Basic rock']);
    const [muted, setMuted] = useState({});
    const [bpm, setBpm] = useState(() => Math.min(220, Math.max(40, parseInt(initialBpm, 10) || 100)));
    const [swing, setSwing] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [head, setHead] = useState(-1);
    const [preset, setPreset] = useState('Basic rock');
    const patternRef = useRef(pattern);
    const mutedRef = useRef(muted);
    const seq = useRef(null);
    const taps = useRef([]);
    patternRef.current = pattern;
    mutedRef.current = muted;

    useEffect(() => {
      seq.current = A.createSequencer({
        steps: 16, bpm, swing,
        onStep: (i, t) => {
          const p = patternRef.current;
          const m = mutedRef.current;
          TRACKS.forEach((tr) => { if (p[tr.key][i] && !m[tr.key]) A.drum(tr.key, t, i % 4 === 0 ? 1 : 0.8); });
        },
        onVisual: setHead,
      });
      return () => seq.current && seq.current.stop();
    }, []);
    useEffect(() => { if (seq.current) seq.current.setBpm(bpm); }, [bpm]);
    useEffect(() => { if (seq.current) seq.current.setSwing(swing); }, [swing]);

    const toggle = async () => {
      if (playing) { seq.current.stop(); setPlaying(false); return; }
      await seq.current.start();
      setPlaying(true);
    };
    const toggleCell = (k, i) => setPattern((p) => ({ ...p, [k]: p[k].map((v, j) => (j === i ? !v : v)) }));
    const loadPreset = (name) => { setPreset(name); setPattern(PRESETS[name]); };
    const randomize = () => {
      setPreset('');
      setPattern({
        kick: Array.from({ length: 16 }, (_, i) => i % 4 === 0 || Math.random() < 0.15),
        snare: Array.from({ length: 16 }, (_, i) => i % 8 === 4 || Math.random() < 0.08),
        hihat: Array.from({ length: 16 }, (_, i) => i % 2 === 0 || Math.random() < 0.3),
        clap: Array.from({ length: 16 }, () => Math.random() < 0.1),
      });
    };
    const tap = () => {
      const t = performance.now();
      taps.current = taps.current.filter((x) => t - x < 2500).concat(t).slice(-8);
      if (taps.current.length >= 2) {
        const diffs = taps.current.slice(1).map((x, i) => x - taps.current[i]);
        const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        setBpm(Math.round(Math.min(220, Math.max(40, 60000 / avg))));
      }
      A.playDrum('hihat', 0.6);
    };

    return html`<div class="card">
      <div class="card-head">
        <span class="section-icon violet"><${Icon} name="activity" /></span>
        <div><div class="card-title">Rhythm Lab</div><div class="card-sub">16-step sequencer med swing og tap tempo</div></div>
        <div class="card-actions">
          <button class="btn btn-sm" onClick=${randomize}><${Icon} name="shuffle" /> Tilfældig</button>
          <button class="btn btn-sm" onClick=${() => { setPreset(''); setPattern(emptyPattern()); }}><${Icon} name="trash" /> Ryd</button>
          <button class=${'btn btn-sm ' + (playing ? 'btn-danger' : 'btn-primary')} onClick=${toggle} aria-pressed=${playing}>
            <${Icon} name=${playing ? 'stop' : 'play'} fill /> ${playing ? 'Stop' : 'Afspil'}</button>
        </div>
      </div>
      <div class="grid-3" style="margin-bottom:18px;align-items:end">
        <div class="field">
          <span class="label">Tempo</span>
          <div class="row">
            <div class="bpm-display">${bpm}<small>BPM</small></div>
            <button class="btn btn-sm" onClick=${tap} title="Tap tempo">Tap</button>
          </div>
          <input type="range" min="40" max="220" value=${bpm} onInput=${(e) => setBpm(Number(e.target.value))} aria-label="BPM" />
        </div>
        <label class="field"><span class="label">Swing <span class="hint">${Math.round(swing * 100)}%</span></span>
          <input type="range" min="0" max="50" value=${Math.round(swing * 100)} onInput=${(e) => setSwing(Number(e.target.value) / 100)} /></label>
        <label class="field"><span class="label">Preset</span>
          <select class="select" value=${preset} onChange=${(e) => loadPreset(e.target.value)}>
            <option value="" disabled>Vælg…</option>
            ${Object.keys(PRESETS).map((p) => html`<option key=${p} value=${p}>${p}</option>`)}
          </select></label>
      </div>
      <div class="seq">
        <div class="seq-ruler"><span></span><div>${Array.from({ length: 16 }, (_, i) => html`<span key=${i} class=${i % 4 === 0 ? 'beat' : ''}>${i % 4 === 0 ? i / 4 + 1 : '·'}</span>`)}</div></div>
        ${TRACKS.map((tr) => html`<div class="seq-row" key=${tr.key}>
          <div class=${'seq-label' + (muted[tr.key] ? ' is-muted' : '')}>
            <button type="button" title="Mute / unmute" onClick=${() => setMuted((m) => ({ ...m, [tr.key]: !m[tr.key] }))}>
              <span class="track-dot" style=${{ background: tr.color }}></span>${tr.name}</button>
          </div>
          <div class="seq-cells" style=${{ '--track': tr.color }}>
            ${pattern[tr.key].map((on, i) => html`<button type="button" key=${i} role="checkbox" aria-checked=${on}
              aria-label=${`${tr.name} step ${i + 1}`}
              class=${'cell' + (on ? ' is-on' : '') + (i % 4 === 0 ? ' is-beat' : '') + (head === i ? ' is-head' : '')}
              onClick=${() => toggleCell(tr.key, i)} />`)}
          </div>
        </div>`)}
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------
  const GENRES = ['Pop', 'Indie', 'Hip-hop', 'R&B', 'House', 'Techno', 'Lo-fi', 'Rock', 'Folk', 'Jazz', 'Ambient', 'Synthwave'];
  const MOODS = ['Energisk', 'Melankolsk', 'Drømmende', 'Rå', 'Varm', 'Mørk', 'Legende', 'Episk', 'Intim'];
  const BPMS = ['72', '85', '92', '100', '110', '120', '128', '140', '174'];

  function InputView({ params, setParams, onGenerate, onCancel, loading, error, settings }) {
    const set = (k) => (e) => setParams({ ...params, [k]: e.target.value });
    const pick = (k) => (v) => setParams({ ...params, [k]: params[k] === v ? '' : v });
    const key = T.parseKey(params.key);
    const cfg = activeConfig(settings);
    const meta = AI.PROVIDERS[cfg.provider];
    return html`<div class="view">
      <div class="hero">
        <div class="eyebrow">Session</div>
        <h1 class="hero-title">Hvad arbejder <em>du</em> på?</h1>
        <p class="hero-sub">Beskriv projektet, så bygger din AI-coach konkrete forslag til akkorder, melodi, groove, arrangement og next steps. Alt kan afprøves i værktøjerne bagefter.</p>
      </div>
      ${error ? html`<div class="alert err" style="margin-bottom:16px"><${Icon} name="alert" /><div>${error}</div></div>` : null}
      <div class="card">
        <div class="form-grid">
          <div class="field">
            <label class="label" for="f-genre">Genre</label>
            <input id="f-genre" class="input" value=${params.genre} onInput=${set('genre')} placeholder="fx Indie pop, Techno" />
            <${Chips} options=${GENRES} value=${params.genre} onPick=${pick('genre')} />
          </div>
          <div class="field">
            <label class="label" for="f-mood">Mood / stemning</label>
            <input id="f-mood" class="input" value=${params.mood} onInput=${set('mood')} placeholder="fx Melankolsk men håbefuld" />
            <${Chips} options=${MOODS} value=${params.mood} onPick=${pick('mood')} color="teal" />
          </div>
          <div class="field">
            <label class="label" for="f-bpm">BPM</label>
            <input id="f-bpm" class="input mono" inputmode="numeric" value=${params.bpm} onInput=${set('bpm')} placeholder="fx 120 eller 90-100" />
            <${Chips} options=${BPMS} value=${params.bpm} onPick=${pick('bpm')} />
          </div>
          <div class="field">
            <label class="label" for="f-key">Toneart <span class="hint">${key ? `${key.root} ${key.mode === 'minor' ? 'mol' : 'dur'} genkendt` : 'fx "Am", "F# mol", "Bb dur"'}</span></label>
            <input id="f-key" class="input mono" value=${params.key} onInput=${set('key')} placeholder="fx Am, D dur, F#m" />
            <div class="chips">
              ${['C', 'G', 'D', 'A', 'E', 'F', 'Bb', 'Eb'].map((r) => html`<button type="button" key=${r} class=${'chip' + (key && key.root === T.normalizeNote(r) && key.mode === 'major' ? ' is-on' : '')} onClick=${() => setParams({ ...params, key: r })}>${r}</button>`)}
              ${['Am', 'Em', 'Dm', 'Bm', 'F#m', 'Cm', 'Gm'].map((r) => html`<button type="button" key=${r} class=${'chip teal' + (key && key.root === T.normalizeNote(r) && key.mode === 'minor' ? ' is-on' : '')} onClick=${() => setParams({ ...params, key: r })}>${r}</button>`)}
            </div>
          </div>
          <div class="field span-2">
            <label class="label" for="f-ref">Referencer</label>
            <input id="f-ref" class="input" value=${params.references} onInput=${set('references')} placeholder="fx The Weeknd, Fred again.., Phoebe Bridgers" />
          </div>
          <div class="field span-2">
            <label class="label" for="f-existing">Eksisterende materiale</label>
            <textarea id="f-existing" class="textarea" value=${params.existing} onInput=${set('existing')} placeholder="Riff, tekstlinje, loop, demo – hvad har du allerede?"></textarea>
          </div>
          <div class="field">
            <label class="label" for="f-constraints">Begrænsninger</label>
            <input id="f-constraints" class="input" value=${params.constraints} onInput=${set('constraints')} placeholder="fx kun software, 2 timer, ingen vokal" />
          </div>
          <div class="field">
            <label class="label" for="f-goals">Mål</label>
            <input id="f-goals" class="input" value=${params.goals} onInput=${set('goals')} placeholder="fx radio-klar single, live-sæt, portfolio" />
          </div>
        </div>
        <div class="row" style="margin-top:22px">
          ${loading
            ? html`<button class="btn btn-lg btn-danger" onClick=${onCancel}><${Icon} name="x" /> Afbryd</button>
                   <div class="grow"><div class="progress-line"></div><div class="small muted" style="margin-top:8px">Arbejder via <b>${meta.label}</b>${cfg.model ? html` · <span class="mono">${cfg.model}</span>` : ''}…</div></div>`
            : html`<button class="btn btn-lg btn-primary" onClick=${onGenerate}><${Icon} name="sparkles" /> Generér forslag</button>
                   <span class="small muted">eller <span class="kbd">Ctrl</span> + <span class="kbd">↵</span></span>
                   <span class="grow"></span>
                   <span class="small muted">${meta.id === 'demo' ? 'Demo-tilstand: ingen AI-kald. Vælg en provider under ' : 'Kører via '}<b>${meta.id === 'demo' ? '⚙ AI' : meta.label}</b></span>`}
        </div>
      </div>
    </div>`;
  }

  function ToolsView({ params, chordLab, setChordLab }) {
    return html`<div class="view stack">
      <div class="hero" style="margin-bottom:6px">
        <div class="eyebrow">Værktøjer</div>
        <h1 class="hero-title">Hør det, <em>før</em> du bygger det</h1>
      </div>
      <${ScaleLab} initialKey=${params.key} onPickChord=${(c) => setChordLab({ ...chordLab, chord: c })} />
      <${ChordLab} chord=${chordLab.chord} progression=${chordLab.progression} bpm=${params.bpm} onChord=${(c) => setChordLab((s) => ({ ...s, chord: c }))} />
      <${RhythmLab} initialBpm=${params.bpm} />
    </div>`;
  }

  const SECTIONS = [
    { key: 'questions', title: 'Afklarende spørgsmål', icon: 'help', tone: 'violet', list: 'q' },
    { key: 'directions', title: 'Kreative retninger', icon: 'compass', tone: '' },
    { key: 'melodies', title: 'Melodiske ideer', icon: 'music', tone: 'teal' },
    { key: 'rhythm', title: 'Rytme & groove', icon: 'activity', tone: 'violet' },
    { key: 'arrangement', title: 'Arrangement', icon: 'layers', tone: '' },
    { key: 'production', title: 'Produktion & mix', icon: 'sliders', tone: 'teal' },
    { key: 'lyrics', title: 'Tekst & temaer', icon: 'feather', tone: 'warn' },
    { key: 'actions', title: 'Next steps', icon: 'target', tone: 'ok', list: 'check' },
  ];

  function ResultsView({ result, chordLab, setChordLab, onCopy, onDownload, onRedo }) {
    if (!result) {
      return html`<div class="view card"><div class="empty"><${Icon} name="sparkles" size=${42} />
        <div><b>Ingen resultater endnu</b></div><div>Udfyld projektinfo og tryk Generér forslag.</div></div></div>`;
    }
    const s = result.suggestions;
    const m = result.meta || {};
    const activeProg = chordLab.progression;
    const playProg = (p) => setChordLab({ chord: p.chords[0], progression: p.chords, autoplay: Date.now() });
    return html`<div class="view stack">
      <div class="hero" style="margin-bottom:4px">
        <div class="eyebrow">Resultater</div>
        <h1 class="hero-title">Din <em>kreative</em> plan</h1>
      </div>
      <div class="summary">
        ${s.summary ? html`<p>${s.summary}</p>` : null}
        <div class="meta-line">
          <span><b>${AI.PROVIDERS[m.provider]?.label || m.provider || '—'}</b>${m.model ? html` · <span class="mono">${m.model}</span>` : ''}</span>
          ${m.durationMs ? html`<span>${(m.durationMs / 1000).toFixed(1)} s</span>` : null}
          ${m.usage && (m.usage.input_tokens || m.usage.prompt_tokens) ? html`<span>${(m.usage.input_tokens || m.usage.prompt_tokens)} → ${(m.usage.output_tokens || m.usage.completion_tokens || 0)} tokens</span>` : null}
          ${m.usage && m.usage.cache_read_input_tokens ? html`<span>cache: ${m.usage.cache_read_input_tokens}</span>` : null}
          <span>${new Date(result.timestamp).toLocaleString('da-DK')}</span>
        </div>
        <div class="row">
          <button class="btn btn-sm" onClick=${onCopy}><${Icon} name="copy" /> Kopiér som Markdown</button>
          <button class="btn btn-sm" onClick=${onDownload}><${Icon} name="download" /> Download JSON</button>
          <button class="btn btn-sm btn-ghost" onClick=${onRedo}><${Icon} name="refresh" /> Kør igen</button>
        </div>
      </div>

      ${s.chords.length ? html`<div class="card">
        <div class="card-head">
          <span class="section-icon"><${Icon} name="disc" /></span>
          <div><div class="card-title">Akkordprogressioner</div><div class="card-sub">Klik på en akkord for voicing – eller afspil hele progressionen</div></div>
        </div>
        <div class="grid-2" style="margin-bottom:${activeProg ? '18px' : '0'}">
          ${s.chords.map((p, i) => html`<div key=${i} class=${'prog' + (activeProg === p.chords ? ' is-active' : '')}>
            <div class="prog-head">
              <span class="prog-label">${p.label}</span>
              <span class="grow"></span>
              ${p.chords.length ? html`<button class="btn btn-sm" onClick=${() => playProg(p)}><${Icon} name="play" fill /> Afspil</button>` : null}
            </div>
            ${p.chords.length ? html`<div class="prog-chords">
              ${p.chords.map((c, j) => html`<${Fragment} key=${c + j}>
                <button type="button" class=${'chord-pill' + (chordLab.chord === c && activeProg === p.chords ? ' is-active' : '')}
                  onClick=${() => { setChordLab({ chord: c, progression: p.chords }); A.playChord(T.chordVoicing(c, 4), { duration: 1.4 }); }}>${c}</button>
                ${j < p.chords.length - 1 ? html`<span class="chord-arrow">→</span>` : null}
              <//>`)}
            </div>` : null}
            ${p.note ? html`<div class="prog-note">${p.note}</div>` : null}
          </div>`)}
        </div>
        ${activeProg ? html`<${ChordLab} compact chord=${chordLab.chord} progression=${activeProg} bpm=${result.params?.bpm} autoplay=${chordLab.autoplay}
          onChord=${(c) => setChordLab((st) => ({ ...st, chord: c }))} />` : null}
      </div>` : null}

      <div class="grid-2">
        ${SECTIONS.filter((sec) => s[sec.key] && s[sec.key].length).map((sec) => html`<div class="card" key=${sec.key}>
          <div class="card-head">
            <span class=${'section-icon ' + sec.tone}><${Icon} name=${sec.icon} /></span>
            <div class="card-title">${sec.title}</div>
          </div>
          <ul class=${'list ' + (sec.list || '')}>${s[sec.key].map((it, i) => html`<li key=${i}>${it}</li>`)}</ul>
        </div>`)}
      </div>
    </div>`;
  }

  function HistoryView({ history, onLoad, onDelete, onClear }) {
    return html`<div class="view stack">
      <div class="hero" style="margin-bottom:4px">
        <div class="eyebrow">Historik</div>
        <h1 class="hero-title">Tidligere <em>sessioner</em></h1>
      </div>
      ${history.length === 0
        ? html`<div class="card"><div class="empty"><${Icon} name="clock" size=${42} /><div>Ingen gemte sessioner endnu.</div></div></div>`
        : html`<div class="card">
          <div class="card-head"><div class="card-sub">Gemmes lokalt i din browser (seneste 20)</div>
            <div class="card-actions"><button class="btn btn-sm btn-danger" onClick=${onClear}><${Icon} name="trash" /> Ryd alt</button></div></div>
          <div class="stack" style="gap:10px">
            ${history.map((hItem) => html`<div class="prog hist-item" key=${hItem.timestamp}>
              <div>
                <div class="title">${[hItem.params.genre, hItem.params.mood, hItem.params.key, hItem.params.bpm && hItem.params.bpm + ' BPM'].filter(Boolean).join(' · ') || 'Uden titel'}</div>
                <div class="sub">${new Date(hItem.timestamp).toLocaleString('da-DK')} · ${AI.PROVIDERS[hItem.meta?.provider]?.label || hItem.meta?.provider || ''}${hItem.suggestions.summary ? ' · ' + hItem.suggestions.summary.slice(0, 90) + (hItem.suggestions.summary.length > 90 ? '…' : '') : ''}</div>
              </div>
              <div class="row" style="flex-wrap:nowrap">
                <button class="btn btn-sm" onClick=${() => onLoad(hItem)}><${Icon} name="arrow" /> Åbn</button>
                <button class="btn btn-sm btn-icon btn-ghost" aria-label="Slet" onClick=${() => onDelete(hItem.timestamp)}><${Icon} name="x" /></button>
              </div>
            </div>`)}
          </div>
        </div>`}
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Settings drawer
  // ---------------------------------------------------------------------------
  function SettingsDrawer({ settings, onChange, onClose, toast }) {
    const meta = AI.PROVIDERS[settings.provider];
    const cfg = settings.configs[meta.id] || {};
    const [status, setStatus] = useState(null);
    const [models, setModels] = useState([]);
    const [testing, setTesting] = useState(false);
    const setCfg = (patch) => onChange({ ...settings, configs: { ...settings.configs, [meta.id]: { ...cfg, ...patch } } });
    useEffect(() => { setStatus(null); setModels([]); }, [settings.provider]);
    useEffect(() => {
      const onKey = (e) => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const test = async () => {
      setTesting(true);
      setStatus(null);
      try {
        const client = AI.createClient(activeConfig(settings));
        const r = await client.ping(); // EXTERNAL CALL (except demo)
        setStatus(r);
        if (r.ok) {
          setModels(r.models);
          if (!cfg.model && r.models.length && meta.id !== 'demo') setCfg({ model: r.models[0] });
          toast(`Forbundet til ${meta.label} (${r.latencyMs} ms)`, 'ok');
        }
      } catch (e) {
        setStatus({ ok: false, error: e.message });
      } finally {
        setTesting(false);
      }
    };

    return html`<${Fragment}>
      <div class="drawer-backdrop" onClick=${onClose}></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="AI-indstillinger">
        <div class="drawer-head">
          <span class="section-icon"><${Icon} name="settings" /></span>
          <h2>AI-indstillinger</h2>
          <span class="grow"></span>
          <button class="btn btn-icon btn-ghost" aria-label="Luk" onClick=${onClose}><${Icon} name="x" /></button>
        </div>
        <div class="provider-list" role="radiogroup" aria-label="Provider">
          ${Object.values(AI.PROVIDERS).map((p) => html`<button type="button" key=${p.id} role="radio" aria-checked=${settings.provider === p.id}
            class=${'provider-opt' + (settings.provider === p.id ? ' is-on' : '')} onClick=${() => onChange({ ...settings, provider: p.id })}>
            <span class="radio"></span>
            <span><b>${p.label}</b><small>${p.hint}</small></span>
            <span class=${'tag ' + (p.id === 'demo' ? 'demo' : p.local ? '' : 'cloud')}>${p.id === 'demo' ? 'demo' : p.local ? 'lokal' : 'cloud'}</span>
          </button>`)}
        </div>
        ${meta.id !== 'demo' ? html`<${Fragment}>
          <label class="field"><span class="label">Base URL</span>
            <input class="input mono" value=${cfg.baseUrl ?? meta.baseUrl} onInput=${(e) => setCfg({ baseUrl: e.target.value })} spellcheck="false" /></label>
          ${meta.needsKey || meta.id === 'openai_compatible' ? html`<label class="field">
            <span class="label">API-nøgle ${meta.needsKey ? '' : html`<span class="hint">valgfri</span>`}</span>
            <input class="input mono" type="password" autocomplete="off" value=${cfg.apiKey || ''} placeholder=${meta.keyPrefix ? meta.keyPrefix + '…' : ''}
              onInput=${(e) => setCfg({ apiKey: e.target.value })} /></label>` : null}
          <label class="field"><span class="label">Model <span class="hint">${models.length ? `${models.length} fundet` : ''}</span></span>
            <input class="input mono" list="ms-models" value=${cfg.model ?? meta.defaultModel} placeholder=${meta.defaultModel || 'fx llama3.1, qwen2.5:7b'} spellcheck="false"
              onInput=${(e) => setCfg({ model: e.target.value })} />
            <datalist id="ms-models">${models.map((mName) => html`<option key=${mName} value=${mName} />`)}</datalist></label>
          <div class="row">
            <button class="btn" onClick=${test} disabled=${testing}>${testing ? html`<span class="spinner"></span>` : html`<${Icon} name="zap" />`} Test forbindelse${meta.local ? ' & hent modeller' : ''}</button>
            ${status ? html`<div class=${'status-line ' + (status.ok ? 'ok' : 'err')}><span class="dot"></span>${status.ok ? `OK · ${status.latencyMs} ms` : status.error}</div>` : null}
          </div>
          ${meta.local ? html`<div class="alert info"><${Icon} name="info" /><div>${meta.hint}${meta.id === 'ollama' ? html`<br /><span class="mono small">OLLAMA_ORIGINS="*" ollama serve</span>` : ''}</div></div>` : html`<div class="alert warn"><${Icon} name="alert" /><div>Nøglen gemmes kun i denne browsers localStorage og sendes direkte til ${meta.label}. Del aldrig denne side med nøglen gemt.</div></div>`}
        <//>` : html`<div class="alert info"><${Icon} name="info" /><div>Demo-tilstand genererer deterministiske forslag ud fra toneart og genre – helt uden netværk. Vælg Ollama eller LM Studio for rigtig lokal AI.</div></div>`}
        <label class="field"><span class="label">Kreativitet (temperature) <span class="hint">${settings.temperature.toFixed(1)}</span></span>
          <input type="range" min="0" max="1.5" step="0.1" value=${settings.temperature} onInput=${(e) => onChange({ ...settings, temperature: Number(e.target.value) })} /></label>
        <div class="row">
          <button class="btn btn-primary" onClick=${onClose}><${Icon} name="check" /> Færdig</button>
          ${cfg.apiKey ? html`<button class="btn btn-ghost btn-danger" onClick=${() => setCfg({ apiKey: '' })}>Ryd nøgle</button>` : null}
          <span class="grow"></span>
          <span class="small muted">SDK v${AI.VERSION}</span>
        </div>
      </aside>
    <//>`;
  }

  // ---------------------------------------------------------------------------
  // App
  // ---------------------------------------------------------------------------
  const TABS = [
    { id: 'input', label: 'Input', icon: 'edit' },
    { id: 'tools', label: 'Værktøjer', icon: 'sliders' },
    { id: 'results', label: 'Resultater', icon: 'sparkles' },
    { id: 'history', label: 'Historik', icon: 'clock' },
  ];

  function App() {
    const [tab, setTabRaw] = useState(() => store.get(KEYS.tab, 'input'));
    const [params, setParamsRaw] = useState(loadParams);
    const [settings, setSettingsRaw] = useState(loadSettings);
    const [history, setHistoryRaw] = useState(() => store.get(KEYS.history, []));
    const [result, setResult] = useState(() => store.get(KEYS.history, [])[0] || null);
    const [chordLab, setChordLab] = useState({ chord: '', progression: null });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [drawer, setDrawer] = useState(false);
    const [toasts, setToasts] = useState([]);
    const abortRef = useRef(null);

    const setTab = useCallback((t) => { setTabRaw(t); store.set(KEYS.tab, t); window.scrollTo({ top: 0 }); }, []);
    const setParams = useCallback((p) => { setParamsRaw(p); store.set(KEYS.params, p); }, []);
    const setSettings = useCallback((s) => { setSettingsRaw(s); store.set(KEYS.settings, s); }, []);
    const setHistory = useCallback((hs) => { setHistoryRaw(hs); store.set(KEYS.history, hs); }, []);
    const toast = useCallback((text, kind = 'info') => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t, { id, text, kind }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
    }, []);

    const cancel = useCallback(() => { if (abortRef.current) abortRef.current.abort(); }, []);

    const generate = useCallback(async () => {
      if (loading) return;
      const cfg = activeConfig(settings);
      const client = AI.createClient(cfg);
      try {
        client.validate();
      } catch (e) {
        setError(e.message);
        setDrawer(true);
        return;
      }
      setLoading(true);
      setError('');
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        // EXTERNAL CALL: LLM request (none in demo mode).
        const { suggestions, meta } = await client.generateSuggestions(params, { signal: ctrl.signal });
        const entry = { timestamp: new Date().toISOString(), params: { ...params }, suggestions, meta: { provider: meta.provider, model: meta.model, durationMs: meta.durationMs, usage: meta.usage } };
        setResult(entry);
        setHistory([entry, ...history].slice(0, 20));
        setChordLab({ chord: '', progression: null });
        setTab('results');
        toast(`Forslag klar via ${AI.PROVIDERS[meta.provider]?.label || meta.provider} på ${(meta.durationMs / 1000).toFixed(1)} s`, 'ok');
      } catch (e) {
        if (e && e.code === 'aborted') { toast('Afbrudt', 'info'); } else {
          const msg = e && e.message ? e.message : 'Ukendt fejl';
          setError(msg);
          toast(msg, 'err');
          if (e && (e.code === 'missing_key' || e.code === 'bad_key' || e.code === 'missing_model' || e.code === 'auth')) setDrawer(true);
        }
      } finally {
        setLoading(false);
        abortRef.current = null;
      }
    }, [loading, settings, params, history, setHistory, setTab, toast]);

    // Keyboard shortcuts (refs → one listener, never stale between renders)
    const liveRef = useRef({});
    liveRef.current = { generate, drawer };
    useEffect(() => {
      const onKey = (e) => {
        const live = liveRef.current;
        const tag = (e.target && e.target.tagName) || '';
        const typing = /INPUT|TEXTAREA|SELECT/.test(tag);
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); live.generate(); return; }
        if (typing || live.drawer || e.ctrlKey || e.metaKey || e.altKey) return;
        const idx = ['1', '2', '3', '4'].indexOf(e.key);
        if (idx >= 0) setTab(TABS[idx].id);
        if (e.key === ',') setDrawer(true);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [setTab]);

    // Warn only while a request is in flight.
    useEffect(() => {
      if (!loading) return undefined;
      const h2 = (e) => { e.preventDefault(); e.returnValue = ''; };
      window.addEventListener('beforeunload', h2);
      return () => window.removeEventListener('beforeunload', h2);
    }, [loading]);

    const copyMarkdown = async () => {
      if (!result) return;
      const md = AI.suggestionsToMarkdown(result.suggestions, result.params);
      try {
        await navigator.clipboard.writeText(md);
        toast('Markdown kopieret', 'ok');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = md;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('Markdown kopieret', 'ok'); } catch { toast('Kunne ikke kopiere', 'err'); }
        ta.remove();
      }
    };
    const downloadJSON = () => {
      if (!result) return;
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `musiksparring-${result.timestamp.slice(0, 19).replace(/[:T]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    const cfg = activeConfig(settings);
    const meta = AI.PROVIDERS[cfg.provider];
    const pillClass = meta.id === 'demo' ? 'is-demo' : meta.local ? 'is-local' : 'is-cloud';

    return html`<${Fragment}>
      <header class="topbar">
        <a class="brand" href="#" onClick=${(e) => { e.preventDefault(); setTab('input'); }}>
          <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span class="brand-name">MusikSparring<small>Pro · AI Creative Coach</small></span>
        </a>
        <span class="topbar-spacer"></span>
        <button class=${'provider-pill ' + pillClass + (loading ? ' is-busy' : '')} onClick=${() => setDrawer(true)} title="AI-indstillinger (,)">
          <span class="dot"></span><span><b>${meta.id === 'demo' ? 'Demo' : meta.label.replace(/\s*\(.*\)$/, '')}</b>${cfg.model && meta.id !== 'demo' ? ` · ${cfg.model}` : ''}</span>
          <${Icon} name="settings" size=${15} />
        </button>
      </header>
      <nav class="nav" aria-label="Hovedmenu">
        ${TABS.map((t2, i) => html`<button key=${t2.id} class=${'nav-btn' + (tab === t2.id ? ' is-active' : '')} onClick=${() => setTab(t2.id)}
          aria-current=${tab === t2.id ? 'page' : undefined} title=${`${t2.label} (${i + 1})`}>
          <${Icon} name=${t2.icon} size=${22} />${t2.label}
          ${t2.id === 'results' && result && tab !== 'results' ? html`<span class="badge" aria-hidden="true"></span>` : null}
        </button>`)}
      </nav>
      <main class="main"><div class="container">
        ${tab === 'input' ? html`<${InputView} params=${params} setParams=${setParams} onGenerate=${generate} onCancel=${cancel} loading=${loading} error=${error} settings=${settings} />` : null}
        ${tab === 'tools' ? html`<${ToolsView} params=${params} chordLab=${chordLab} setChordLab=${setChordLab} />` : null}
        ${tab === 'results' ? html`<${ResultsView} result=${result} chordLab=${chordLab} setChordLab=${setChordLab} onCopy=${copyMarkdown} onDownload=${downloadJSON} onRedo=${() => { setTab('input'); generate(); }} />` : null}
        ${tab === 'history' ? html`<${HistoryView} history=${history}
          onLoad=${(hItem) => { setResult(hItem); setParams({ ...EMPTY_PARAMS, ...hItem.params }); setChordLab({ chord: '', progression: null }); setTab('results'); }}
          onDelete=${(ts) => setHistory(history.filter((x) => x.timestamp !== ts))}
          onClear=${() => { if (window.confirm('Slet hele historikken?')) setHistory([]); }} />` : null}
        <footer class="foot">MusikSparring Pro v3 · Lokal-først: dine data forlader kun browseren, når du selv vælger en cloud-provider. · Genveje: 1–4 skifter fane, <span class="kbd">,</span> åbner AI-indstillinger</footer>
      </div></main>
      ${drawer ? html`<${SettingsDrawer} settings=${settings} onChange=${setSettings} onClose=${() => setDrawer(false)} toast=${toast} />` : null}
      <${Toasts} items=${toasts} />
    <//>`;
  }

  render(html`<${App} />`, document.getElementById('root'));
})();
