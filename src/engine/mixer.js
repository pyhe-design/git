/**
 * The mixer owns both decks, the single shared poll loop and all mix state.
 * The UI subscribes and never touches a player directly.
 *
 * Call-budget design:
 *  - ONE timer for the whole app, at UI_HZ, not one per deck and not per frame.
 *    Consumers that need 60 fps (the canvas) extrapolate from the last sample's
 *    timestamp rather than asking the player again.
 *  - Volume is recomputed only when something in the gain chain changes, then
 *    coalesced by the deck into at most one integer write per frame.
 *  - The drift corrector is rate-limited and deadbanded in core/sync.js.
 */

import { autoFadeStep, crossfadeGains, stageVolume } from '../core/crossfade.js';
import { applyCorrection, captureOffset, createSyncState, decideCorrection } from '../core/sync.js';
import { beatPhase, phaseDelta, phaseDeltaSeconds } from '../core/tempo.js';
import { STATE } from './deck.js';

/** Poll rate for clock/UI state. Enough for a readout, cheap enough to ignore. */
export const UI_HZ = 15;

/** @typedef {'a'|'b'} DeckId */

/** @type {DeckId[]} */
const IDS = ['a', 'b'];

/** @param {DeckId} id @returns {DeckId} */
export const other = (id) => (id === 'a' ? 'b' : 'a');

export class Mixer {
  /**
   * @param {object} options
   * @param {import('../core/store.js').Session} options.session
   * @param {(event: string, payload?: any) => void} [options.onEvent]
   */
  constructor({ session, onEvent = () => {} }) {
    this.onEvent = onEvent;
    /** @type {Record<DeckId, import('./deck.js').Deck|null>} */
    this.decks = { a: null, b: null };

    this.position = session.position;
    this.curve = session.curve;
    this.master = session.master;
    this.privacyMode = session.privacyMode;
    this.fadeSeconds = session.fadeSeconds;

    /** @type {Record<DeckId, {trim: number, muted: boolean, bpm: number, anchor: number, cues: number[]}>} */
    this.channels = {
      a: { trim: session.decks.a.trim, muted: false, bpm: session.decks.a.bpm, anchor: session.decks.a.anchor, cues: [...session.decks.a.cues] },
      b: { trim: session.decks.b.trim, muted: false, bpm: session.decks.b.bpm, anchor: session.decks.b.anchor, cues: [...session.decks.b.cues] },
    };

    this.sync = createSyncState();
    /** @type {string} */ this.syncStatus = 'sync off';
    /** @type {number} */ this.drift = 0;

    /** @type {Record<DeckId, import('./deck.js').DeckSample & {sampledAt: number}>} */
    this.samples = {
      a: { time: 0, duration: 0, state: STATE.UNSTARTED, playing: false, muted: false, rate: 1, sampledAt: 0 },
      b: { time: 0, duration: 0, state: STATE.UNSTARTED, playing: false, muted: false, rate: 1, sampledAt: 0 },
    };

    /** @type {{active: boolean, from: number, to: number, startedAt: number, duration: number}} */
    this.autoFade = { active: false, from: 0, to: 1, startedAt: 0, duration: 0 };

    /** @type {Set<() => void>} */
    this.listeners = new Set();
    /** @type {any} */ this.timer = null;
    /** @type {any} */ this.fadeHandle = null;
  }

  /**
   * @param {() => void} fn
   * @returns {() => void} unsubscribe.
   */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** @returns {void} */
  notify() {
    for (const fn of this.listeners) fn();
  }

  /**
   * @param {DeckId} id
   * @param {import('./deck.js').Deck} deck
   */
  attach(id, deck) {
    this.decks[id] = deck;
    this.applyGains();
  }

  /** Start the one shared poll loop. */
  start() {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), Math.round(1000 / UI_HZ));
  }

  /** @returns {void} */
  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.cancelAutoFade();
  }

  /** One pass: sample both decks, run the drift corrector, publish. */
  tick() {
    const now = Date.now();
    for (const id of IDS) {
      const deck = this.decks[id];
      if (deck) this.samples[id] = { ...deck.sample(), sampledAt: now };
    }
    this.runSync(now);
    this.notify();
  }

  // --------------------------------------------------------------- gain chain

  /** @returns {{a: number, b: number}} amplitude gains after the crossfader. */
  fadeGains() {
    return crossfadeGains(this.position, /** @type {any} */ (this.curve));
  }

  /**
   * Volume each deck should be at right now, as the integer the API takes.
   * @returns {Record<DeckId, number>}
   */
  volumes() {
    const fades = this.fadeGains();
    return {
      a: stageVolume({ fade: fades.a, trim: this.channels.a.trim, master: this.master, muted: this.channels.a.muted }),
      b: stageVolume({ fade: fades.b, trim: this.channels.b.trim, master: this.master, muted: this.channels.b.muted }),
    };
  }

  /** Push the computed volumes down to the decks (which coalesce the writes). */
  applyGains() {
    const v = this.volumes();
    for (const id of IDS) this.decks[id]?.setVolume(v[id]);
  }

  /** @param {number} value */
  setPosition(value) {
    this.cancelAutoFade();
    this.position = Math.max(0, Math.min(1, value));
    this.applyGains();
    this.notify();
  }

  /** @param {string} curve */
  setCurve(curve) {
    this.curve = curve;
    this.applyGains();
    this.notify();
  }

  /** @param {number} value */
  setMaster(value) {
    this.master = Math.max(0, Math.min(1, value));
    this.applyGains();
    this.notify();
  }

  /**
   * @param {DeckId} id
   * @param {number} value
   */
  setTrim(id, value) {
    this.channels[id].trim = Math.max(0, Math.min(1, value));
    this.applyGains();
    this.notify();
  }

  /** @param {DeckId} id */
  toggleMute(id) {
    this.channels[id].muted = !this.channels[id].muted;
    this.applyGains();
    this.notify();
    this.onEvent('announce', {
      message: `Deck ${id.toUpperCase()} ${this.channels[id].muted ? 'killed' : 'live'}`,
    });
  }

  // --------------------------------------------------------------- auto-fade

  /**
   * Ride the crossfader to one side over `seconds`.
   * @param {DeckId} target deck to end up on.
   * @param {number} [seconds]
   */
  startAutoFade(target, seconds = this.fadeSeconds) {
    this.cancelAutoFade();
    const to = target === 'b' ? 1 : 0;
    const duration = Math.max(0, seconds) * 1000;
    this.autoFade = { active: true, from: this.position, to, startedAt: Date.now(), duration };
    const raf = globalThis.requestAnimationFrame ?? ((/** @type {Function} */ fn) => setTimeout(fn, 16));
    const step = () => {
      if (!this.autoFade.active) return;
      const { from, to: dest, startedAt, duration: dur } = this.autoFade;
      const { position, done } = autoFadeStep(from, dest, Date.now() - startedAt, dur);
      this.position = position;
      this.applyGains();
      this.notify();
      if (done) {
        this.autoFade = { ...this.autoFade, active: false };
        this.onEvent('announce', { message: `Auto-fade to deck ${target.toUpperCase()} complete` });
        return;
      }
      this.fadeHandle = raf(step);
    };
    this.onEvent('announce', { message: `Auto-fading to deck ${target.toUpperCase()} over ${seconds} seconds` });
    step();
  }

  /** @returns {void} */
  cancelAutoFade() {
    this.autoFade = { ...this.autoFade, active: false };
    if (this.fadeHandle !== null && globalThis.cancelAnimationFrame) {
      globalThis.cancelAnimationFrame(this.fadeHandle);
    }
    this.fadeHandle = null;
  }

  // -------------------------------------------------------------------- sync

  /** @returns {DeckId} */
  follower() {
    return other(this.sync.leader);
  }

  /**
   * Lock the current time difference in, or release it.
   * @param {DeckId} [leader]
   */
  toggleSync(leader = this.sync.leader) {
    if (this.sync.enabled && leader === this.sync.leader) {
      this.sync = { ...this.sync, enabled: false };
      this.syncStatus = 'sync off';
    } else {
      const offset = captureOffset(this.samples[leader].time, this.samples[other(leader)].time);
      this.sync = { ...this.sync, enabled: true, leader, offset, lastCorrectionAt: 0 };
      this.syncStatus = `locked to deck ${leader.toUpperCase()}`;
    }
    this.notify();
    this.onEvent('announce', { message: this.syncStatus });
  }

  /** Seek the follower onto the lock immediately, bypassing the deadband. */
  snapToLock() {
    if (!this.sync.enabled) return;
    const follower = this.follower();
    const target = Math.max(0, this.samples[this.sync.leader].time + this.sync.offset);
    this.decks[follower]?.seek(target, true);
    this.sync = { ...this.sync, lastCorrectionAt: Date.now(), corrections: this.sync.corrections + 1 };
    this.notify();
  }

  /**
   * Shift the locked offset. Also usable without sync enabled, as a plain nudge
   * of the follower deck.
   * @param {number} delta seconds.
   */
  nudge(delta) {
    const follower = this.follower();
    if (this.sync.enabled) {
      this.sync = { ...this.sync, offset: this.sync.offset + delta, lastCorrectionAt: 0 };
      this.snapToLock();
    } else {
      this.decks[follower]?.seek(Math.max(0, this.samples[follower].time + delta), true);
    }
    this.notify();
  }

  /**
   * Beat phases of both decks, or null where no BPM is known.
   * @returns {Record<DeckId, number|null>}
   */
  phases() {
    /** @type {any} */
    const out = {};
    for (const id of IDS) {
      const { bpm, anchor } = this.channels[id];
      out[id] = bpm > 0 ? beatPhase(this.samples[id].time, bpm, anchor) : null;
    }
    return out;
  }

  /**
   * Signed beat-phase misalignment, or null when either BPM is unknown.
   * @returns {number|null}
   */
  phaseError() {
    const p = this.phases();
    if (p.a === null || p.b === null) return null;
    return phaseDelta(p[this.sync.leader], p[this.follower()]);
  }

  /**
   * Nudge the follower so its beats land on the leader's. Needs both BPMs.
   * @returns {boolean} false when there was nothing to align.
   */
  alignBeats() {
    const delta = this.phaseError();
    const bpm = this.channels[this.follower()].bpm;
    if (delta === null || !(bpm > 0)) return false;
    this.nudge(phaseDeltaSeconds(delta, bpm));
    this.onEvent('announce', { message: 'Beat phase aligned' });
    return true;
  }

  /**
   * @param {number} now epoch ms.
   */
  runSync(now) {
    const leader = this.sync.leader;
    const follower = this.follower();
    const decision = decideCorrection({
      state: this.sync,
      leaderTime: this.samples[leader].time,
      followerTime: this.samples[follower].time,
      bothPlaying: this.samples.a.playing && this.samples.b.playing,
      now,
    });
    this.drift = decision.drift;
    this.syncStatus = decision.reason;
    if (decision.action === 'seek' && decision.target !== undefined) {
      this.decks[follower]?.seek(decision.target, true);
    }
    const next = applyCorrection(this.sync, decision, now);
    if (next !== this.sync) {
      this.sync = next;
      if (decision.action === 'abandon') {
        this.onEvent('announce', { message: 'Sync released: a deck was scrubbed' });
      }
    }
  }

  // -------------------------------------------------------------------- decks

  /**
   * @param {DeckId} id
   * @param {number} bpm
   */
  setBpm(id, bpm) {
    this.channels[id].bpm = Math.max(0, bpm);
    this.notify();
  }

  /** Pin the beat grid to wherever the deck is now. @param {DeckId} id */
  setAnchorHere(id) {
    this.channels[id].anchor = this.samples[id].time;
    this.notify();
    this.onEvent('announce', { message: `Deck ${id.toUpperCase()} downbeat set` });
  }

  /** Drop a cue point at the playhead. @param {DeckId} id */
  addCue(id) {
    const cues = this.channels[id].cues;
    if (cues.length >= 8) cues.shift();
    cues.push(this.samples[id].time);
    this.notify();
    this.onEvent('announce', { message: `Cue ${cues.length} set on deck ${id.toUpperCase()}` });
  }

  /**
   * @param {DeckId} id
   * @param {number} index
   */
  jumpToCue(id, index) {
    const at = this.channels[id].cues[index];
    if (at === undefined) return;
    this.decks[id]?.seek(at, true);
    this.notify();
  }

  /** @param {DeckId} id */
  clearCues(id) {
    this.channels[id].cues = [];
    this.notify();
  }

  /** Total player calls made, for the call-budget readout. @returns {number} */
  callCount() {
    return (this.decks.a?.calls ?? 0) + (this.decks.b?.calls ?? 0);
  }
}
