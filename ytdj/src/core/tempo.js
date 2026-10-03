/**
 * Tap tempo and beat-grid phase. Pure: no DOM, no timers.
 *
 * There is no way to detect tempo from a YouTube player: the audio is inside a
 * cross-origin iframe, so no AnalyserNode and no samples. BPM is therefore
 * something the DJ supplies, by tapping or typing. The beat grid built from it
 * is what makes phase misalignment between the two decks visible, which is the
 * closest honest substitute for a waveform display.
 */

/** Taps further apart than this start a new measurement. */
export const TAP_TIMEOUT_MS = 2500;

/** Taps needed before a BPM is reported. */
export const MIN_TAPS = 4;

export const MIN_BPM = 40;
export const MAX_BPM = 220;

/**
 * @typedef {object} TapState
 * @property {number[]} taps epoch ms, oldest first, capped.
 */

/** @returns {TapState} */
export function createTapState() {
  return { taps: [] };
}

/**
 * Register a tap.
 * @param {TapState} state
 * @param {number} now epoch ms.
 * @returns {TapState} new state; never mutates the input.
 */
export function tap(state, now) {
  const last = state.taps[state.taps.length - 1];
  const taps = last !== undefined && now - last > TAP_TIMEOUT_MS ? [] : state.taps.slice(-15);
  return { taps: [...taps, now] };
}

/**
 * BPM from the tap history, using the *median* inter-tap interval so one
 * fumbled tap does not drag the estimate the way a mean would.
 * @param {TapState} state
 * @returns {number|null} BPM rounded to one decimal, or null when undecided.
 */
export function tappedBpm(state) {
  if (state.taps.length < MIN_TAPS) return null;
  const gaps = [];
  for (let i = 1; i < state.taps.length; i += 1) gaps.push(state.taps[i] - state.taps[i - 1]);
  gaps.sort((x, y) => x - y);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  if (!(median > 0)) return null;
  const bpm = 60000 / median;
  if (bpm < MIN_BPM || bpm > MAX_BPM) return null;
  return Math.round(bpm * 10) / 10;
}

/**
 * Fold a BPM into the usual DJ range by halving or doubling, so a tap on the
 * off-beat of a 170 BPM track still reads as 85 rather than being rejected.
 * @param {number} bpm
 * @returns {number}
 */
export function normalizeBpm(bpm) {
  let value = bpm;
  while (value > MAX_BPM) value /= 2;
  while (value > 0 && value < MIN_BPM) value *= 2;
  return Math.round(value * 10) / 10;
}

/**
 * Position within the current beat.
 * @param {number} time playhead, in seconds.
 * @param {number} bpm
 * @param {number} [anchor] seconds; the downbeat the grid is pinned to.
 * @returns {number} phase in [0, 1); 0 is on the beat.
 */
export function beatPhase(time, bpm, anchor = 0) {
  if (!(bpm > 0) || !Number.isFinite(time)) return 0;
  const period = 60 / bpm;
  const phase = ((time - anchor) / period) % 1;
  return phase < 0 ? phase + 1 : phase;
}

/**
 * Beat number since the anchor, for a bar/beat readout.
 * @param {number} time seconds.
 * @param {number} bpm
 * @param {number} [anchor] seconds.
 * @returns {number} may be negative before the anchor.
 */
export function beatCount(time, bpm, anchor = 0) {
  if (!(bpm > 0) || !Number.isFinite(time)) return 0;
  return Math.floor((time - anchor) / (60 / bpm));
}

/**
 * Shortest signed distance between two decks' beat phases.
 * Zero means the beats land together; +-0.5 means fully off-beat.
 * @param {number} phaseA
 * @param {number} phaseB
 * @returns {number} in [-0.5, 0.5].
 */
export function phaseDelta(phaseA, phaseB) {
  let d = (phaseB - phaseA) % 1;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

/**
 * Seconds of offset trim that would bring the follower's beat onto the leader's.
 * @param {number} delta from `phaseDelta`.
 * @param {number} bpm
 * @returns {number} seconds; 0 when no BPM is known.
 */
export function phaseDeltaSeconds(delta, bpm) {
  if (!(bpm > 0)) return 0;
  return -delta * (60 / bpm);
}

/**
 * @param {number} seconds
 * @returns {string} `m:ss` or `h:mm:ss`, `-:--` for an unknown duration.
 */
export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-:--';
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
