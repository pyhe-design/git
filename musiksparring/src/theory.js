/* MusikSparring — music theory module (browser global `Theory`). Pure functions, no side effects. */
(function (root) {
  'use strict';

  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const FLAT_TO_SHARP = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' };

  function normalizeNote(note) {
    if (!note) return null;
    const m = String(note).trim().match(/^([A-Ga-g])([#b♯♭]?)/);
    if (!m) return null;
    const acc = m[2].replace('♯', '#').replace('♭', 'b');
    const raw = m[1].toUpperCase() + acc;
    return FLAT_TO_SHARP[raw] || raw;
  }

  const noteIndex = (note) => NOTES.indexOf(normalizeNote(note));
  const transpose = (note, semis) => NOTES[((noteIndex(note) + semis) % 12 + 12) % 12];
  const midi = (note, octave) => 12 * (octave + 1) + noteIndex(note);
  const freq = (note, octave) => 440 * 2 ** ((midi(note, octave) - 69) / 12);

  const SCALES = {
    'Dur (Ionisk)': { steps: [0, 2, 4, 5, 7, 9, 11], names: ['R', 'M2', 'M3', 'P4', 'P5', 'M6', 'M7'] },
    'Mol (Æolisk)': { steps: [0, 2, 3, 5, 7, 8, 10], names: ['R', 'M2', 'm3', 'P4', 'P5', 'm6', 'm7'] },
    'Dorisk': { steps: [0, 2, 3, 5, 7, 9, 10], names: ['R', 'M2', 'm3', 'P4', 'P5', 'M6', 'm7'] },
    'Frygisk': { steps: [0, 1, 3, 5, 7, 8, 10], names: ['R', 'm2', 'm3', 'P4', 'P5', 'm6', 'm7'] },
    'Lydisk': { steps: [0, 2, 4, 6, 7, 9, 11], names: ['R', 'M2', 'M3', 'A4', 'P5', 'M6', 'M7'] },
    'Mixolydisk': { steps: [0, 2, 4, 5, 7, 9, 10], names: ['R', 'M2', 'M3', 'P4', 'P5', 'M6', 'm7'] },
    'Lokrisk': { steps: [0, 1, 3, 5, 6, 8, 10], names: ['R', 'm2', 'm3', 'P4', 'd5', 'm6', 'm7'] },
    'Harmonisk mol': { steps: [0, 2, 3, 5, 7, 8, 11], names: ['R', 'M2', 'm3', 'P4', 'P5', 'm6', 'M7'] },
    'Melodisk mol': { steps: [0, 2, 3, 5, 7, 9, 11], names: ['R', 'M2', 'm3', 'P4', 'P5', 'M6', 'M7'] },
    'Pentaton dur': { steps: [0, 2, 4, 7, 9], names: ['R', 'M2', 'M3', 'P5', 'M6'] },
    'Pentaton mol': { steps: [0, 3, 5, 7, 10], names: ['R', 'm3', 'P4', 'P5', 'm7'] },
    'Blues': { steps: [0, 3, 5, 6, 7, 10], names: ['R', 'm3', 'P4', 'd5', 'P5', 'm7'] },
  };

  const getScaleNotes = (root, scale) => SCALES[scale].steps.map((s) => transpose(root, s));

  const QUALITIES = {
    '': [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], 5: [0, 7],
    6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
    dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10], mmaj7: [0, 3, 7, 11], add9: [0, 4, 7, 14],
    9: [0, 4, 7, 10, 14], m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14], 11: [0, 4, 7, 10, 14, 17],
    13: [0, 4, 7, 10, 14, 21], add11: [0, 4, 7, 17],
  };
  const QUALITY_ALIASES = {
    maj: '', M: '', major: '', min: 'm', minor: 'm', '-': 'm', '-7': 'm7', 'Δ': 'maj7', 'Δ7': 'maj7', M7: 'maj7',
    '°': 'dim', 'º': 'dim', o: 'dim', 'ø': 'm7b5', 'ø7': 'm7b5', '+': 'aug', sus: 'sus4', mMaj7: 'mmaj7', maj13: '13',
    m11: '11', min7: 'm7',
  };
  const QUALITY_LABELS = {
    '': 'dur', m: 'mol', dim: 'formindsket', aug: 'forstørret', sus2: 'sus2', sus4: 'sus4', 5: 'power chord',
    6: 'sekst', m6: 'mol sekst', 7: 'dominant 7', maj7: 'maj7', m7: 'mol 7', dim7: 'dim7', m7b5: 'halvformindsket',
    mmaj7: 'mol maj7', add9: 'add9', 9: 'dominant 9', m9: 'mol 9', maj9: 'maj9', 11: '11', 13: '13', add11: 'add11',
  };

  /** Parse "F#m7/A" → { symbol, root, quality, intervals, bass, label } or null. */
  function parseChord(symbol) {
    if (!symbol) return null;
    const m = String(symbol).trim().match(/^([A-Ga-g])([#b♯♭]?)([^/\s]*)(?:\/([A-G][#b♯♭]?))?$/);
    if (!m) return null;
    const root = normalizeNote(m[1] + m[2]);
    let q = m[3] || '';
    if (QUALITY_ALIASES[q] !== undefined) q = QUALITY_ALIASES[q];
    if (QUALITIES[q] === undefined) return null;
    const bass = m[4] ? normalizeNote(m[4]) : null;
    return {
      symbol: root + q + (bass ? '/' + bass : ''),
      root, quality: q, intervals: QUALITIES[q], bass,
      label: `${root} ${QUALITY_LABELS[q] || q}`,
    };
  }

  const chordNotes = (symbol) => {
    const c = parseChord(symbol);
    return c ? c.intervals.map((i) => transpose(c.root, i)) : [];
  };

  /** Ascending voicing from a base octave: [{note, octave, midi}]. */
  function chordVoicing(symbol, baseOctave = 4) {
    const c = parseChord(symbol);
    if (!c) return [];
    const rootMidi = midi(c.root, baseOctave);
    const toObj = (n) => ({ note: NOTES[n % 12], octave: Math.floor(n / 12) - 1, midi: n });
    let tones = c.intervals.map((i) => rootMidi + i);
    if (c.bass && c.bass !== c.root) {
      // Slash chord: bass note lowest, remaining chord tones stacked above it (inversion).
      const b = midi(c.bass, baseOctave);
      tones = tones
        .filter((n) => n % 12 !== b % 12)
        .map((n) => (n <= b ? n + 12 : n))
        .sort((x, y) => x - y);
      tones.unshift(b);
    }
    return tones.map(toObj);
  }

  // ---- Keys & roman numerals -------------------------------------------------

  function parseKey(text) {
    if (!text) return null;
    const m = String(text).trim().match(/^([A-Ga-g][#b♯♭]?)\s*(.*)$/);
    if (!m) return null;
    const rest = m[2].toLowerCase().trim();
    const minor = /^(m\b|min|minor|mol|aeolian|æolisk|-)/.test(rest);
    return { root: normalizeNote(m[1]), mode: minor ? 'minor' : 'major' };
  }

  const ROMAN = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };
  const DEGREE_STEPS = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
  const DEGREE_QUAL = { major: ['', 'm', 'm', '', '', 'm', 'dim'], minor: ['m', 'dim', '', 'm', 'm', '', ''] };

  function diatonicChords(root, mode) {
    const steps = DEGREE_STEPS[mode] || DEGREE_STEPS.major;
    const quals = DEGREE_QUAL[mode] || DEGREE_QUAL.major;
    const romans = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
    return steps.map((s, i) => {
      const q = quals[i];
      const roman = q === 'm' ? romans[i].toLowerCase() : q === 'dim' ? romans[i].toLowerCase() + '°' : romans[i];
      return { degree: i + 1, roman, symbol: transpose(root, s) + q };
    });
  }

  /** "I–V–vi–IV" in a key → ["C","G","Am","F"]. Unknown tokens are skipped. */
  function romanToChords(text, key) {
    const k = typeof key === 'string' ? parseKey(key) : key;
    if (!k || !text) return [];
    const steps = DEGREE_STEPS[k.mode];
    return String(text)
      .split(/[\s–—|,-]+/)
      .map((tok) => {
        const m = tok.match(/^([#b]?)([ivIV]+)(°|º|o|ø|\+)?(maj7|m7b5|7|9|sus4|sus2)?$/);
        if (!m) return null;
        const deg = ROMAN[m[2].toLowerCase()];
        if (deg === undefined) return null;
        const acc = m[1] === '#' ? 1 : m[1] === 'b' ? -1 : 0;
        const root = transpose(k.root, steps[deg] + acc);
        const minor = m[2] === m[2].toLowerCase();
        let q = minor ? 'm' : '';
        if (m[3] === '°' || m[3] === 'º' || m[3] === 'o') q = 'dim';
        if (m[3] === 'ø') q = 'm7b5';
        if (m[3] === '+') q = 'aug';
        if (m[4]) {
          if (m[4] === '7') q = q === 'm' ? 'm7' : q === 'dim' ? 'dim7' : q === '' ? '7' : q;
          else if (m[4] === 'maj7') q = 'maj7';
          else if (m[4] === '9') q = q === 'm' ? 'm9' : '9';
          else q = m[4];
        }
        return root + q;
      })
      .filter(Boolean);
  }

  // ---- Guitar -----------------------------------------------------------------

  const TUNING = ['E', 'A', 'D', 'G', 'B', 'E']; // low → high
  const TUNING_OCT = [2, 2, 3, 3, 3, 4];

  // Movable shapes: frets per string low→high relative to the open shape, -1 = muted.
  const E_SHAPES = {
    '': [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], 7: [0, 2, 0, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0],
    maj7: [0, 2, 1, 1, 0, 0], sus4: [0, 2, 2, 2, 0, 0], 5: [0, 2, 2, -1, -1, -1], add9: [0, 2, 2, 1, 0, 2],
  };
  const A_SHAPES = {
    '': [-1, 0, 2, 2, 2, 0], m: [-1, 0, 2, 2, 1, 0], 7: [-1, 0, 2, 0, 2, 0], m7: [-1, 0, 2, 0, 1, 0],
    maj7: [-1, 0, 2, 1, 2, 0], sus4: [-1, 0, 2, 2, 3, 0], sus2: [-1, 0, 2, 2, 0, 0], dim: [-1, 0, 1, 2, 1, -1],
    aug: [-1, 0, 3, 2, 2, 1], 6: [-1, 0, 2, 2, 2, 2], add9: [-1, 0, 2, 4, 2, 0], 9: [-1, 0, 2, 4, 2, 3],
    m6: [-1, 0, 2, 2, 1, 2], dim7: [-1, 0, 1, 2, 1, 2], m7b5: [-1, 0, 1, 0, 1, -1], 5: [-1, 0, 2, 2, -1, -1],
    m9: [-1, 0, 2, 4, 1, 3], mmaj7: [-1, 0, 2, 1, 1, 0], maj9: [-1, 0, 2, 1, 0, 0],
  };

  /**
   * Playable guitar shape for a chord symbol:
   * { frets: number[6], base: number, barre: boolean, root: string } or null if no shape known.
   */
  function guitarShape(symbol) {
    const c = parseChord(symbol);
    if (!c) return null;
    const ri = noteIndex(c.root);
    const candidates = [];
    if (E_SHAPES[c.quality]) candidates.push({ shape: E_SHAPES[c.quality], offset: (ri - 4 + 12) % 12 });
    if (A_SHAPES[c.quality]) candidates.push({ shape: A_SHAPES[c.quality], offset: (ri - 9 + 12) % 12 });
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.offset - b.offset);
    const { shape, offset } = candidates[0];
    const frets = shape.map((f) => (f < 0 ? -1 : f + offset));
    const played = frets.filter((f) => f > 0);
    const base = played.length ? Math.min(...played) : 0;
    return { frets, base: offset > 0 ? Math.max(1, Math.min(base, offset)) : 0, barre: offset > 0, root: c.root };
  }

  /** Note name at a fretboard position. stringIdx 0 = low E. */
  const fretNote = (stringIdx, fret) => transpose(TUNING[stringIdx], fret);
  const fretMidi = (stringIdx, fret) => midi(TUNING[stringIdx], TUNING_OCT[stringIdx]) + fret;

  root.Theory = Object.freeze({
    NOTES, FLAT_NAMES, SCALES, QUALITIES, QUALITY_LABELS, TUNING,
    normalizeNote, noteIndex, transpose, midi, freq,
    getScaleNotes, parseChord, chordNotes, chordVoicing,
    parseKey, diatonicChords, romanToChords,
    guitarShape, fretNote, fretMidi,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
