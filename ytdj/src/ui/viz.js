/**
 * Canvas visualisations.
 *
 * An honest note, because this is where YouTube DJ apps usually lie: there is
 * no spectrum analyser here and there cannot be one. The audio plays inside a
 * cross-origin iframe, so the page can never obtain samples from it -- no
 * MediaElementSource, no AnalyserNode, no getByteFrequencyData. Anything drawn
 * as a "spectrum" over a YouTube embed is synthesised noise that happens to
 * wiggle. So these visuals draw things that are actually true:
 *
 *   - the gain the mixer is applying to each deck (a fader meter, not a VU meter)
 *   - the crossfade curve and where the fader sits on it
 *   - each deck's beat-grid phase, from the BPM the DJ supplied, so phase
 *     misalignment between the decks is visible
 *   - playback position against duration
 *
 * All three run from one rAF loop and read extrapolated clock values, so they
 * cost no extra player calls.
 */

import { crossfadeGains } from '../core/crossfade.js';
import { beatPhase } from '../core/tempo.js';

/**
 * Resize a canvas for the device pixel ratio. Returns the CSS-pixel size.
 * @param {HTMLCanvasElement} canvas
 * @param {number} cssHeight
 * @returns {{ctx: CanvasRenderingContext2D|null, w: number, h: number}}
 */
function prepare(canvas, cssHeight) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 300;
  const h = cssHeight;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ctx: null, w, h };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/**
 * Read a themed colour out of the live CSS custom properties, so the canvas
 * follows the theme switcher without the drawing code knowing any palettes.
 * @param {HTMLElement} el
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function cssVar(el, name, fallback) {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Crossfade curve plot with the current position marked.
 * @param {HTMLCanvasElement} canvas
 * @param {object} state
 * @param {number} state.position
 * @param {string} state.curve
 */
export function drawCurve(canvas, { position, curve }) {
  const { ctx, w, h } = prepare(canvas, 96);
  if (!ctx) return;
  const pad = 8;
  const plotW = w - pad * 2;
  const plotH = h - pad * 2;
  const colorA = cssVar(canvas, '--accent-a', '#62e3c6');
  const colorB = cssVar(canvas, '--accent-b', '#f0a24b');
  const line = cssVar(canvas, '--line-strong', '#323a4a');

  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const frac of [0, 0.5, 1]) {
    const x = pad + plotW * frac;
    ctx.moveTo(x, pad);
    ctx.lineTo(x, pad + plotH);
  }
  ctx.stroke();

  for (const [key, color] of /** @type {[('a'|'b'), string][]} */ ([['a', colorA], ['b', colorB]])) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 64; i += 1) {
      const x = i / 64;
      const gain = crossfadeGains(x, /** @type {any} */ (curve))[key];
      const px = pad + plotW * x;
      const py = pad + plotH * (1 - gain);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  const markerX = pad + plotW * Math.max(0, Math.min(1, position));
  ctx.strokeStyle = cssVar(canvas, '--text', '#e8ecf4');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(markerX, pad - 4);
  ctx.lineTo(markerX, pad + plotH + 4);
  ctx.stroke();
}

/**
 * Fader-gain meter. Labelled as gain, not level, because it is gain.
 * @param {HTMLCanvasElement} canvas
 * @param {object} state
 * @param {number} state.gain amplitude in [0, 1].
 * @param {boolean} state.playing
 * @param {'a'|'b'} state.side
 */
export function drawMeter(canvas, { gain, playing, side }) {
  const { ctx, w, h } = prepare(canvas, 10);
  if (!ctx) return;
  const accent = cssVar(canvas, side === 'a' ? '--accent-a' : '--accent-b', '#62e3c6');
  const line = cssVar(canvas, '--line-strong', '#323a4a');
  const segments = 28;
  const gapPx = 2;
  const segW = (w - gapPx * (segments - 1)) / segments;
  const lit = Math.round(Math.max(0, Math.min(1, gain)) * segments);
  for (let i = 0; i < segments; i += 1) {
    const on = i < lit;
    ctx.fillStyle = on ? accent : line;
    ctx.globalAlpha = on ? (playing ? 1 : 0.4) : 0.35;
    ctx.fillRect(i * (segW + gapPx), 0, segW, h);
  }
  ctx.globalAlpha = 1;
}

/**
 * Beat-phase wheel for both decks. Two dots orbit at each deck's BPM; when the
 * dots meet, the beats are aligned. This replaces the waveform display that a
 * local-file DJ app would have, and it is the only alignment aid that is
 * actually derivable from a YouTube player's clock.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} state
 * @param {{time: number, bpm: number, anchor: number, playing: boolean}} state.a
 * @param {{time: number, bpm: number, anchor: number, playing: boolean}} state.b
 */
export function drawPhaseWheel(canvas, { a, b }) {
  const { ctx, w, h } = prepare(canvas, 140);
  if (!ctx) return;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 18;
  const line = cssVar(canvas, '--line-strong', '#323a4a');
  const faint = cssVar(canvas, '--text-faint', '#5d6a7f');

  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Quarter marks: the four beats of a bar.
  ctx.strokeStyle = faint;
  for (let i = 0; i < 4; i += 1) {
    const angle = (i / 4) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * (radius - 6), cy + Math.sin(angle) * (radius - 6));
    ctx.lineTo(cx + Math.cos(angle) * (radius + 6), cy + Math.sin(angle) * (radius + 6));
    ctx.stroke();
  }

  const decks = /** @type {[('a'|'b'), typeof a, string][]} */ ([
    ['a', a, cssVar(canvas, '--accent-a', '#62e3c6')],
    ['b', b, cssVar(canvas, '--accent-b', '#f0a24b')],
  ]);

  let any = false;
  for (const [, deck, color] of decks) {
    if (!(deck.bpm > 0)) continue;
    any = true;
    const phase = beatPhase(deck.time, deck.bpm, deck.anchor);
    const angle = phase * Math.PI * 2 - Math.PI / 2;
    const r = radius;
    ctx.fillStyle = color;
    ctx.globalAlpha = deck.playing ? 1 : 0.45;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, 7, 0, Math.PI * 2);
    ctx.fill();
    // A pulse that swells on the beat, so the downbeat is visible at a glance.
    const swell = Math.max(0, 1 - phase * 6);
    if (swell > 0 && deck.playing) {
      ctx.globalAlpha = swell * 0.35;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.45 * swell + 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  if (!any) {
    ctx.fillStyle = faint;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('set a BPM to see the beat grid', cx, cy);
  }
}

/**
 * Playback position bar with cue markers.
 * @param {HTMLCanvasElement} canvas
 * @param {object} state
 * @param {number} state.time
 * @param {number} state.duration
 * @param {number[]} state.cues
 * @param {'a'|'b'} state.side
 */
export function drawTimeline(canvas, { time, duration, cues, side }) {
  const { ctx, w, h } = prepare(canvas, 22);
  if (!ctx) return;
  const accent = cssVar(canvas, side === 'a' ? '--accent-a' : '--accent-b', '#62e3c6');
  const line = cssVar(canvas, '--line-strong', '#323a4a');
  const faint = cssVar(canvas, '--text-faint', '#5d6a7f');
  const trackY = h / 2 - 3;

  ctx.fillStyle = line;
  ctx.fillRect(0, trackY, w, 6);

  if (duration > 0) {
    const frac = Math.max(0, Math.min(1, time / duration));
    ctx.fillStyle = accent;
    ctx.fillRect(0, trackY, w * frac, 6);
    ctx.fillStyle = faint;
    for (const cue of cues) {
      if (cue < 0 || cue > duration) continue;
      ctx.fillRect(Math.round((cue / duration) * w), 2, 2, h - 4);
    }
  }
}

/**
 * Drive every canvas from one animation frame loop.
 *
 * `snapshot()` must return the mixer's last *sampled* values plus the time they
 * were sampled; this loop extrapolates the playhead forward from there instead
 * of asking the players again, which is what keeps 60 fps animation at zero
 * extra player calls.
 *
 * @param {() => {
 *   position: number, curve: string,
 *   decks: Record<'a'|'b', {time: number, duration: number, playing: boolean,
 *     rate: number, sampledAt: number, bpm: number, anchor: number,
 *     gain: number, cues: number[]}>,
 *   targets: Record<string, HTMLCanvasElement|null>
 * }} snapshot
 * @param {boolean} [animate] false honours prefers-reduced-motion.
 * @returns {() => void} stop function.
 */
export function startVizLoop(snapshot, animate = true) {
  let handle = 0;
  let stopped = false;

  const frame = () => {
    if (stopped) return;
    const { position, curve, decks, targets } = snapshot();
    const now = Date.now();

    /** @param {typeof decks['a']} d */
    const nowTime = (d) =>
      d.playing ? d.time + ((now - d.sampledAt) / 1000) * (d.rate || 1) : d.time;

    if (targets.curve) drawCurve(targets.curve, { position, curve });
    if (targets.wheel) {
      drawPhaseWheel(targets.wheel, {
        a: { time: nowTime(decks.a), bpm: decks.a.bpm, anchor: decks.a.anchor, playing: decks.a.playing },
        b: { time: nowTime(decks.b), bpm: decks.b.bpm, anchor: decks.b.anchor, playing: decks.b.playing },
      });
    }
    for (const side of /** @type {('a'|'b')[]} */ (['a', 'b'])) {
      const meter = targets[`meter-${side}`];
      if (meter) drawMeter(meter, { gain: decks[side].gain, playing: decks[side].playing, side });
      const timeline = targets[`timeline-${side}`];
      if (timeline) {
        drawTimeline(timeline, {
          time: nowTime(decks[side]),
          duration: decks[side].duration,
          cues: decks[side].cues,
          side,
        });
      }
    }

    handle = animate
      ? requestAnimationFrame(frame)
      : /** @type {any} */ (setTimeout(frame, 250));
  };

  frame();
  return () => {
    stopped = true;
    if (animate) cancelAnimationFrame(handle);
    else clearTimeout(handle);
  };
}
