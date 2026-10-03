/**
 * Session persistence and theme catalogue. Pure apart from an injected storage
 * backend, so it is testable in Node with a plain object.
 *
 * Storage can throw or come back empty (private windows, blocked site data), so
 * every read and write is guarded and the app renders correctly without it.
 */

import { CURVES } from './crossfade.js';
import { MAX_BPM, MIN_BPM } from './tempo.js';

export const STORAGE_KEY = 'ytdj.session.v1';
export const SCHEMA_VERSION = 1;

/** @typedef {{id: string, label: string, scheme: 'dark'|'light'}} Theme */

/** Theme ids map to `[data-theme]` blocks in styles.css. */
export const THEMES = /** @type {Theme[]} */ ([
  { id: 'midnight', label: 'Midnight', scheme: 'dark' },
  { id: 'noir', label: 'Noir', scheme: 'dark' },
  { id: 'amber', label: 'Amber', scheme: 'dark' },
  { id: 'daylight', label: 'Daylight', scheme: 'light' },
]);

export const DEFAULT_THEME = 'midnight';

/**
 * @typedef {object} DeckSnapshot
 * @property {string|null} videoId
 * @property {string} title
 * @property {string} author
 * @property {number} trim
 * @property {number} bpm 0 when unknown.
 * @property {number} anchor beat-grid downbeat, in seconds.
 * @property {number[]} cues cue points, in seconds.
 */

/**
 * @typedef {object} Session
 * @property {number} version
 * @property {string} theme
 * @property {string} curve
 * @property {number} master
 * @property {number} position crossfader position.
 * @property {number} fadeSeconds auto-fade length.
 * @property {boolean} privacyMode route embeds via youtube-nocookie.com.
 * @property {{a: DeckSnapshot, b: DeckSnapshot}} decks
 */

/** @returns {DeckSnapshot} */
function defaultDeck() {
  return { videoId: null, title: '', author: '', trim: 1, bpm: 0, anchor: 0, cues: [] };
}

/** @returns {Session} */
export function defaultSession() {
  return {
    version: SCHEMA_VERSION,
    theme: DEFAULT_THEME,
    curve: 'equal-power',
    master: 0.85,
    position: 0.5,
    fadeSeconds: 8,
    privacyMode: true,
    decks: { a: defaultDeck(), b: defaultDeck() },
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < min ? min : n > max ? max : n;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
  return typeof value === 'string' ? value.slice(0, 200) : '';
}

/**
 * @param {unknown} raw
 * @returns {DeckSnapshot}
 */
function coerceDeck(raw) {
  const d = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' ? raw : {});
  const bpm = num(d.bpm, 0, 0, MAX_BPM);
  return {
    videoId: typeof d.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(d.videoId) ? d.videoId : null,
    title: str(d.title),
    author: str(d.author),
    trim: num(d.trim, 1, 0, 1),
    bpm: bpm > 0 && bpm < MIN_BPM ? 0 : bpm,
    anchor: num(d.anchor, 0, 0, 86400),
    cues: Array.isArray(d.cues)
      ? d.cues.map((c) => num(c, 0, 0, 86400)).filter((c) => c >= 0).slice(0, 8)
      : [],
  };
}

/**
 * Normalise anything that came out of storage into a usable session.
 * Unknown, stale or hostile shapes degrade to defaults field by field rather
 * than throwing the whole session away.
 * @param {unknown} raw
 * @returns {Session}
 */
export function coerceSession(raw) {
  const base = defaultSession();
  if (!raw || typeof raw !== 'object') return base;
  const s = /** @type {Record<string, unknown>} */ (raw);
  const decks = /** @type {Record<string, unknown>} */ (
    s.decks && typeof s.decks === 'object' ? s.decks : {}
  );
  return {
    version: SCHEMA_VERSION,
    theme: THEMES.some((t) => t.id === s.theme) ? /** @type {string} */ (s.theme) : base.theme,
    curve: CURVES.includes(/** @type {never} */ (s.curve)) ? /** @type {string} */ (s.curve) : base.curve,
    master: num(s.master, base.master, 0, 1),
    position: num(s.position, base.position, 0, 1),
    fadeSeconds: num(s.fadeSeconds, base.fadeSeconds, 0.5, 120),
    privacyMode: typeof s.privacyMode === 'boolean' ? s.privacyMode : base.privacyMode,
    decks: { a: coerceDeck(decks.a), b: coerceDeck(decks.b) },
  };
}

/**
 * @typedef {{getItem(k: string): string|null, setItem(k: string, v: string): void}} StorageLike
 */

/**
 * `localStorage` when it is usable, otherwise an in-memory stand-in so the rest
 * of the app never has to branch on storage being unavailable.
 * @returns {StorageLike}
 */
export function resolveStorage() {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probe = `${STORAGE_KEY}.probe`;
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    }
  } catch {
    /* blocked or quota-exhausted: fall through to memory */
  }
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? /** @type {string} */ (mem.get(k)) : null),
    setItem: (k, v) => void mem.set(k, v),
  };
}

/**
 * @param {StorageLike} storage
 * @returns {Session}
 */
export function loadSession(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return coerceSession(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultSession();
  }
}

/**
 * @param {StorageLike} storage
 * @param {Session} session
 * @returns {boolean} false when the write was rejected.
 */
export function saveSession(storage, session) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(coerceSession(session)));
    return true;
  } catch {
    return false;
  }
}
