/**
 * Offset-lock sync between two decks. Pure: no DOM, no player, no timers.
 *
 * What this can do: hold deck B at a fixed time offset from deck A, correcting
 * drift by seeking the follower.
 *
 * What it deliberately does not claim to do: beatmatching. `setPlaybackRate`
 * only accepts the discrete rates `getAvailablePlaybackRates()` reports
 * (typically 0.25 .. 2 in quarter steps), so there is no fine pitch bend to
 * pull two tracks into tempo agreement. And `seekTo` resolution is bounded by
 * the player's buffer granularity, so corrections land to roughly a tenth of a
 * second, not to a beat.
 */

/** Below this, a seek request is noise: the player cannot honour it. @type {number} */
export const SEEK_RESOLUTION = 0.05;

/** Default tolerated drift, in seconds. Correcting less than this costs more
 * (an audible re-buffer on every seek) than the drift itself. */
export const DEFAULT_DEADBAND = 0.3;

/** Drift beyond this means the user scrubbed; stop fighting them. */
export const DEFAULT_MAX_DRIFT = 5;

/** Minimum gap between corrective seeks, in ms. */
export const DEFAULT_MIN_INTERVAL = 1200;

/**
 * @typedef {object} SyncState
 * @property {boolean} enabled
 * @property {'a'|'b'} leader deck whose clock the other follows.
 * @property {number} offset followerTime - leaderTime, in seconds.
 * @property {number} lastCorrectionAt epoch ms of the last corrective seek.
 * @property {number} corrections count of corrective seeks issued.
 */

/** @returns {SyncState} */
export function createSyncState() {
  return { enabled: false, leader: 'a', offset: 0, lastCorrectionAt: 0, corrections: 0 };
}

/**
 * The offset to lock in when the user hits SYNC.
 * @param {number} leaderTime
 * @param {number} followerTime
 * @returns {number} seconds; positive means the follower is ahead.
 */
export function captureOffset(leaderTime, followerTime) {
  const a = Number.isFinite(leaderTime) ? leaderTime : 0;
  const b = Number.isFinite(followerTime) ? followerTime : 0;
  return b - a;
}

/**
 * How far the follower has slipped from its locked offset.
 * @param {number} leaderTime
 * @param {number} followerTime
 * @param {number} offset
 * @returns {number} seconds; positive means the follower has run ahead of its lock.
 */
export function driftOf(leaderTime, followerTime, offset) {
  return captureOffset(leaderTime, followerTime) - offset;
}

/**
 * @typedef {object} CorrectionDecision
 * @property {'none'|'seek'|'abandon'} action
 * @property {number} [target] absolute follower time to seek to, when action is 'seek'.
 * @property {number} drift the drift the decision was made on.
 * @property {string} reason human-readable, surfaced in the UI status line.
 */

/**
 * Decide whether to spend a seek on the current drift.
 *
 * Every branch that returns 'none' exists to stop the corrector thrashing:
 * a seek makes the player re-buffer, which is audible, so an unnecessary
 * correction is worse than the drift it fixes.
 *
 * @param {object} input
 * @param {SyncState} input.state
 * @param {number} input.leaderTime
 * @param {number} input.followerTime
 * @param {boolean} input.bothPlaying
 * @param {number} input.now epoch ms.
 * @param {number} [input.deadband]
 * @param {number} [input.maxDrift]
 * @param {number} [input.minInterval]
 * @returns {CorrectionDecision}
 */
export function decideCorrection({
  state,
  leaderTime,
  followerTime,
  bothPlaying,
  now,
  deadband = DEFAULT_DEADBAND,
  maxDrift = DEFAULT_MAX_DRIFT,
  minInterval = DEFAULT_MIN_INTERVAL,
}) {
  const drift = driftOf(leaderTime, followerTime, state.offset);
  if (!state.enabled) return { action: 'none', drift, reason: 'sync off' };
  if (!bothPlaying) return { action: 'none', drift, reason: 'both decks must be playing' };
  if (Math.abs(drift) > maxDrift) {
    return { action: 'abandon', drift, reason: 'drift too large, assuming manual scrub' };
  }
  if (Math.abs(drift) <= Math.max(deadband, SEEK_RESOLUTION)) {
    return { action: 'none', drift, reason: 'locked' };
  }
  if (now - state.lastCorrectionAt < minInterval) {
    return { action: 'none', drift, reason: 'correction cooling down' };
  }
  const target = Math.max(0, leaderTime + state.offset);
  return { action: 'seek', target, drift, reason: 'correcting drift' };
}

/**
 * Apply a decision to the state. Returns a new object; never mutates.
 * @param {SyncState} state
 * @param {CorrectionDecision} decision
 * @param {number} now epoch ms.
 * @returns {SyncState}
 */
export function applyCorrection(state, decision, now) {
  if (decision.action === 'seek') {
    return { ...state, lastCorrectionAt: now, corrections: state.corrections + 1 };
  }
  if (decision.action === 'abandon') {
    return { ...state, enabled: false };
  }
  return state;
}

/**
 * Manual offset trim. Quantised to what the player can actually honour.
 * @param {number} offset
 * @param {number} delta seconds, may be negative.
 * @returns {number}
 */
export function nudgeOffset(offset, delta) {
  if (Math.abs(delta) < SEEK_RESOLUTION) return offset;
  return Math.round((offset + delta) * 1000) / 1000;
}

/**
 * @param {number} drift seconds
 * @returns {string} signed millisecond readout, e.g. "+120 ms".
 */
export function formatDrift(drift) {
  const ms = Math.round((Number.isFinite(drift) ? drift : 0) * 1000);
  return `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${Math.abs(ms)} ms`;
}
