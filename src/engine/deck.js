/**
 * One deck: a thin, call-frugal wrapper around a YT.Player.
 *
 * Every player method is a postMessage into a cross-origin iframe, so the two
 * places this file spends effort are (a) coalescing volume writes into at most
 * one integer write per animation frame per deck, and (b) reading clock state
 * from the API's locally cached getters instead of asking the iframe.
 *
 * The iframe is never hidden, shrunk below 200x200 or covered: YouTube's terms
 * require the player stay visible and its controls reachable.
 */

import { needsVolumeWrite } from '../core/crossfade.js';

/** Numeric player states reported by the IFrame API. */
export const STATE = /** @type {const} */ ({
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
});

/** onError `data` codes, mapped to something a user can act on. */
const ERRORS = /** @type {Record<number, string>} */ ({
  2: 'That video id is not valid.',
  5: 'This video cannot play in the HTML5 player.',
  100: 'Video not found. It may be private or deleted.',
  101: 'The owner does not allow this video to be embedded.',
  150: 'The owner does not allow this video to be embedded.',
  153: 'YouTube rejected the request (missing referrer).',
});

/**
 * @typedef {object} DeckSample
 * @property {number} time
 * @property {number} duration
 * @property {number} state
 * @property {boolean} playing
 * @property {boolean} muted
 * @property {number} rate
 */

export class Deck {
  /**
   * @param {object} options
   * @param {'a'|'b'} options.id
   * @param {HTMLElement} options.container element replaced by the iframe.
   * @param {any} options.YT the `YT` namespace from `loadYouTubeApi`.
   * @param {boolean} [options.privacyMode] serve the embed from youtube-nocookie.com.
   * @param {(event: string, payload?: any) => void} [options.onEvent]
   */
  constructor({ id, container, YT, privacyMode = true, onEvent = () => {} }) {
    /** @readonly */ this.id = id;
    this.container = container;
    this.YT = YT;
    this.privacyMode = privacyMode;
    this.onEvent = onEvent;

    /** @type {any} */ this.player = null;
    /** @type {HTMLElement|null} */ this.mount = null;
    /** @type {string|null} */ this.videoId = null;
    this.ready = false;
    /** Last volume actually written to the player. */
    /** @type {number|null} */ this.sentVolume = null;
    /** @type {number} */ this.targetVolume = 0;
    /** @type {number|null} */ this.flushHandle = null;
    /** @type {DeckSample} */
    this.last = { time: 0, duration: 0, state: STATE.UNSTARTED, playing: false, muted: false, rate: 1 };
    /** Counts postMessage-backed calls, surfaced in the UI as an efficiency readout. */
    this.calls = 0;
    this.destroyed = false;
  }

  /**
   * Create the underlying player. Resolves once the API reports it ready.
   * @param {string} videoId
   * @param {number} [startSeconds]
   * @returns {Promise<void>}
   */
  create(videoId, startSeconds = 0) {
    return new Promise((resolve, reject) => {
      const host = this.privacyMode ? 'https://www.youtube-nocookie.com' : 'https://www.youtube.com';
      let settled = false;
      // The API *replaces* the element it is given with the iframe, so give it
      // a mount point we own. Handing it the node the view layer rendered would
      // leave that framework holding a reference to a detached element.
      const mount = this.container.ownerDocument.createElement('div');
      this.container.append(mount);
      this.mount = mount;
      this.player = new this.YT.Player(mount, {
        host,
        videoId,
        playerVars: {
          enablejsapi: 1,
          playsinline: 1,
          rel: 0,
          start: Math.max(0, Math.floor(startSeconds)),
          origin: globalThis.location?.origin,
        },
        events: {
          onReady: () => {
            this.ready = true;
            this.videoId = videoId;
            // Start silent: the mixer writes the real level on its first flush,
            // so a newly loaded deck never bursts in at full volume.
            this.#call('setVolume', 0);
            this.sentVolume = 0;
            this.onEvent('ready', { deck: this.id });
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          onStateChange: (/** @type {{data: number}} */ e) => {
            this.last = { ...this.last, state: e.data, playing: e.data === STATE.PLAYING };
            this.onEvent('state', { deck: this.id, state: e.data });
          },
          onPlaybackRateChange: (/** @type {{data: number}} */ e) => {
            this.last = { ...this.last, rate: e.data };
            this.onEvent('rate', { deck: this.id, rate: e.data });
          },
          onError: (/** @type {{data: number}} */ e) => {
            const message = ERRORS[e.data] ?? `The player reported error ${e.data}.`;
            this.onEvent('error', { deck: this.id, code: e.data, message });
            if (!settled) {
              settled = true;
              reject(new Error(message));
            }
          },
        },
      });
    });
  }

  /**
   * Swap in a different video, reusing the existing player and iframe.
   * @param {string} videoId
   * @param {number} [startSeconds]
   * @returns {Promise<void>}
   */
  async load(videoId, startSeconds = 0) {
    if (!this.player) return this.create(videoId, startSeconds);
    this.videoId = videoId;
    this.sentVolume = null; // the fresh load resets the player's own volume state
    this.#call('cueVideoById', { videoId, startSeconds: Math.max(0, startSeconds) });
    this.last = { ...this.last, time: startSeconds, duration: 0, state: STATE.CUED, playing: false };
    this.onEvent('loaded', { deck: this.id, videoId });
  }

  /**
   * Queue a volume level. Coalesced: at most one `setVolume` per frame, and only
   * when the integer value actually changed.
   * @param {number} volume integer 0-100.
   */
  setVolume(volume) {
    this.targetVolume = Math.round(Math.max(0, Math.min(100, volume)));
    if (this.flushHandle !== null || !this.ready) return;
    const raf = globalThis.requestAnimationFrame ?? ((/** @type {Function} */ fn) => setTimeout(fn, 16));
    this.flushHandle = /** @type {any} */ (raf(() => {
      this.flushHandle = null;
      this.flushVolume();
    }));
  }

  /** Write the pending volume if it differs from what the player already has. */
  flushVolume() {
    if (!this.ready || this.destroyed) return;
    if (!needsVolumeWrite(this.sentVolume, this.targetVolume)) return;
    this.#call('setVolume', this.targetVolume);
    this.sentVolume = this.targetVolume;
  }

  /** @returns {void} */
  play() {
    if (!this.ready) return;
    // A player that the browser muted for autoplay policy stays silent however
    // high we set the volume, so lift it on the user's own gesture.
    if (this.#read('isMuted', false)) this.#call('unMute');
    this.#call('playVideo');
  }

  /** @returns {void} */
  pause() {
    if (this.ready) this.#call('pauseVideo');
  }

  /** @returns {void} */
  togglePlay() {
    if (this.last.playing) this.pause();
    else this.play();
  }

  /**
   * @param {number} seconds
   * @param {boolean} [allowSeekAhead] false while scrubbing, true on release.
   */
  seek(seconds, allowSeekAhead = true) {
    if (!this.ready) return;
    const target = Math.max(0, seconds);
    this.#call('seekTo', target, allowSeekAhead);
    this.last = { ...this.last, time: target };
  }

  /**
   * @param {number} rate must be one of `availableRates()`.
   */
  setRate(rate) {
    if (this.ready) this.#call('setPlaybackRate', rate);
  }

  /** @returns {number[]} the discrete rates this video supports. */
  availableRates() {
    return this.#read('getAvailablePlaybackRates', [1]) ?? [1];
  }

  /**
   * Read the clock. Cheap: the IFrame API serves these from local state kept up
   * to date by the player's own messages, so this does not cross the iframe.
   * @returns {DeckSample}
   */
  sample() {
    if (!this.ready || this.destroyed) return this.last;
    const time = this.#read('getCurrentTime', this.last.time) ?? 0;
    const duration = this.#read('getDuration', this.last.duration) ?? 0;
    const state = this.#read('getPlayerState', this.last.state) ?? STATE.UNSTARTED;
    this.last = {
      time: Number.isFinite(time) ? time : 0,
      duration: Number.isFinite(duration) ? duration : 0,
      state,
      playing: state === STATE.PLAYING,
      muted: this.#read('isMuted', false) ?? false,
      rate: this.#read('getPlaybackRate', this.last.rate) ?? 1,
    };
    return this.last;
  }

  /**
   * Title and channel straight from the player, so the common case needs no
   * network call of our own.
   * @returns {{title: string, author: string}|null}
   */
  metadata() {
    const data = this.#read('getVideoData', null);
    if (!data || typeof data !== 'object') return null;
    return { title: String(data.title ?? ''), author: String(data.author ?? '') };
  }

  /** @returns {void} */
  destroy() {
    this.destroyed = true;
    if (this.flushHandle !== null && globalThis.cancelAnimationFrame) {
      globalThis.cancelAnimationFrame(/** @type {any} */ (this.flushHandle));
    }
    this.flushHandle = null;
    try {
      this.player?.destroy?.();
    } catch {
      /* the iframe may already be gone */
    }
    // destroy() swaps the iframe back for the mount div, so remove that too.
    try {
      this.mount?.remove();
      for (const frame of [...this.container.querySelectorAll('iframe')]) frame.remove();
    } catch {
      /* the container may already be detached */
    }
    this.mount = null;
    this.player = null;
    this.ready = false;
  }

  /**
   * Invoke a player method, counting it and swallowing the races that happen
   * when the iframe is torn down mid-flight.
   * @param {string} method
   * @param {...any} args
   */
  #call(method, ...args) {
    const fn = this.player?.[method];
    if (typeof fn !== 'function') return;
    this.calls += 1;
    try {
      fn.apply(this.player, args);
    } catch (error) {
      this.onEvent('warn', { deck: this.id, method, error: String(error) });
    }
  }

  /**
   * Read a player getter, falling back when the player is not answering yet.
   * @template T
   * @param {string} method
   * @param {T} fallback
   * @returns {T}
   */
  #read(method, fallback) {
    const fn = this.player?.[method];
    if (typeof fn !== 'function') return fallback;
    try {
      const value = fn.call(this.player);
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }
}
