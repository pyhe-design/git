/**
 * Crossfader + gain staging maths. Pure: no DOM, no player, no network.
 *
 * Why this file exists instead of a Web Audio graph: a YouTube IFrame player is a
 * cross-origin iframe, so its audio cannot be routed through an AudioContext
 * (no MediaElementSource, no GainNode, no AnalyserNode). The only volume control
 * is `player.setVolume(0..100)`, an integer, delivered by postMessage. Every curve
 * here therefore ends in an integer and we aggressively avoid redundant writes.
 */

/** @typedef {'equal-power'|'linear'|'sharp'} CurveName */

/** Fraction of fader travel over which `sharp` cuts. */
const SHARP_WIDTH = 0.15;

export const CURVES = /** @type {const} */ (['equal-power', 'linear', 'sharp']);

export const CURVE_LABELS = /** @type {Record<CurveName, string>} */ ({
  'equal-power': 'Equal power (-3 dB centre)',
  linear: 'Linear (-6 dB centre)',
  sharp: 'Sharp cut (both open mid-travel)',
});

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Amplitude gain for each deck at a crossfader position.
 *
 * `equal-power` keeps summed power constant, so the mix does not dip in the
 * middle the way a linear fader does; both decks sit at 0.707 (-3 dB) at centre.
 *
 * @param {number} position 0 = deck A only, 1 = deck B only.
 * @param {CurveName} [curve]
 * @returns {{a: number, b: number}} amplitude gains in [0, 1].
 */
export function crossfadeGains(position, curve = 'equal-power') {
  const x = clamp(Number.isFinite(position) ? position : 0.5, 0, 1);
  switch (curve) {
    case 'linear':
      return { a: 1 - x, b: x };
    case 'sharp':
      return {
        a: clamp((1 - x) / SHARP_WIDTH, 0, 1),
        b: clamp(x / SHARP_WIDTH, 0, 1),
      };
    case 'equal-power':
    default:
      return { a: Math.cos((x * Math.PI) / 2), b: Math.sin((x * Math.PI) / 2) };
  }
}

/**
 * Collapse the gain chain into the single integer the IFrame API accepts.
 * @param {object} stage
 * @param {number} stage.fade  crossfader gain for this deck, [0, 1].
 * @param {number} stage.trim  per-deck line fader, [0, 1].
 * @param {number} stage.master master fader, [0, 1].
 * @param {boolean} [stage.muted] deck kill switch.
 * @returns {number} integer in [0, 100].
 */
export function stageVolume({ fade, trim, master, muted = false }) {
  if (muted) return 0;
  const gain = clamp(fade, 0, 1) * clamp(trim, 0, 1) * clamp(master, 0, 1);
  return Math.round(clamp(gain, 0, 1) * 100);
}

/**
 * Should we spend a postMessage on this volume change?
 * The IFrame API quantises to integers, so writing 42 over 42 is pure overhead.
 * @param {number|null} current last value we actually sent, null if never.
 * @param {number} target
 * @returns {boolean}
 */
export function needsVolumeWrite(current, target) {
  return current === null || current !== target;
}

/**
 * Amplitude gain as dB, for the meter readout. Floors at -60 instead of -Infinity.
 * @param {number} gain amplitude in [0, 1].
 * @returns {number} dB, clamped to [-60, 0].
 */
export function gainToDb(gain) {
  const g = clamp(gain, 0, 1);
  return g <= 0.001 ? -60 : clamp(20 * Math.log10(g), -60, 0);
}

/**
 * Crossfader position after `elapsed` ms of an auto-fade.
 * Position moves linearly in time; the curve supplies the loudness shaping.
 * @param {number} from start position [0, 1].
 * @param {number} to end position [0, 1].
 * @param {number} elapsed ms since the fade started.
 * @param {number} duration total fade length in ms; <= 0 jumps straight to `to`.
 * @returns {{position: number, done: boolean}}
 */
export function autoFadeStep(from, to, elapsed, duration) {
  if (!(duration > 0)) return { position: clamp(to, 0, 1), done: true };
  const t = clamp(elapsed / duration, 0, 1);
  return { position: clamp(from + (to - from) * t, 0, 1), done: t >= 1 };
}

/**
 * Human-readable fader position, for `aria-valuetext` and the on-screen label.
 * @param {number} position
 * @returns {string}
 */
export function describePosition(position) {
  const x = clamp(position, 0, 1);
  if (x <= 0.001) return 'Deck A only';
  if (x >= 0.999) return 'Deck B only';
  if (Math.abs(x - 0.5) < 0.02) return 'Both decks equal';
  const pct = Math.round(x * 100);
  return x < 0.5 ? `${100 - pct}% toward deck A` : `${pct}% toward deck B`;
}
