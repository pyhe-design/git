/** Presentational components. No player access, no mixer mutation beyond the
 * callbacks handed in. */

import { h } from 'preact';
import htm from 'htm';
import { CURVE_LABELS, CURVES, describePosition, gainToDb } from '../core/crossfade.js';
import { formatClock } from '../core/tempo.js';
import { THEMES } from '../core/store.js';
import { formatDrift } from '../core/sync.js';

export const html = htm.bind(h);

/**
 * A labelled slider that always carries a spoken value.
 * @param {object} props
 * @param {string} props.id
 * @param {string} props.label
 * @param {number} props.value
 * @param {number} props.min
 * @param {number} props.max
 * @param {number} props.step
 * @param {string} props.display printed next to the label.
 * @param {string} props.valueText for `aria-valuetext`.
 * @param {(value: number) => void} props.onInput
 * @param {string} [props.className]
 */
export function Fader({ id, label, value, min, max, step, display, valueText, onInput, className = '' }) {
  return html`
    <div class="field ${className}">
      <label class="field-label" for=${id}>
        <span>${label}</span>
        <span class="value">${display}</span>
      </label>
      <input
        id=${id}
        type="range"
        min=${min}
        max=${max}
        step=${step}
        value=${value}
        aria-valuetext=${valueText}
        onInput=${(/** @type {any} */ e) => onInput(Number(e.currentTarget.value))}
      />
    </div>
  `;
}

/**
 * One deck: loader, the (always visible) player stage, transport, trim, tempo.
 * @param {object} props
 */
export function DeckPanel({
  side,
  draft,
  onDraft,
  onLoad,
  loading,
  track,
  sample,
  channel,
  gain,
  volume,
  onTogglePlay,
  onSeek,
  onTrim,
  onMute,
  onTap,
  onBpm,
  onAnchor,
  onCue,
  onJumpCue,
  onClearCues,
  onRate,
  rates,
  canvasRef,
  timelineRef,
  stageRef,
}) {
  const upper = side.toUpperCase();
  const loaded = Boolean(track.videoId);
  const duration = sample.duration;
  return html`
    <section class="deck" data-side=${side} id=${`deck-${side}`} aria-labelledby=${`deck-${side}-title`}>
      <div class="deck-head">
        <span class="deck-badge" aria-hidden="true">${upper}</span>
        <h2 class="deck-title" id=${`deck-${side}-title`}>
          ${track.title || `Deck ${upper}`}
          <small>${track.author || (loaded ? 'Loaded' : 'Nothing loaded')}</small>
        </h2>
      </div>

      <div class="loader-row">
        <label class="sr-only" for=${`url-${side}`}>YouTube URL or video id for deck ${upper}</label>
        <input
          id=${`url-${side}`}
          type="text"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="YouTube URL or video id"
          value=${draft}
          onInput=${(/** @type {any} */ e) => onDraft(e.currentTarget.value)}
          onKeyDown=${(/** @type {any} */ e) => {
            if (e.key === 'Enter') onLoad();
          }}
        />
        <button class="primary" onClick=${onLoad} disabled=${loading || !draft.trim()}>
          ${loading ? 'Loading…' : 'Load'}
        </button>
      </div>

      <!-- The iframe lives here and is never hidden or covered: YouTube's terms
           require the player stay visible with its controls reachable. -->
      <div class="stage">
        <div ref=${stageRef}></div>
        ${!loaded &&
        html`<p class="stage-empty">
          Paste a link above to load deck ${upper}.<br />The video stays visible while you mix.
        </p>`}
      </div>

      <canvas
        ref=${timelineRef}
        role="img"
        aria-label=${`Deck ${upper} playback position, ${formatClock(sample.time)} of ${formatClock(duration)}`}
      ></canvas>

      <div class="field">
        <label class="field-label" for=${`seek-${side}`}>
          <span>Position</span>
          <span class="value">${formatClock(sample.time)} / ${formatClock(duration)}</span>
        </label>
        <input
          id=${`seek-${side}`}
          type="range"
          min="0"
          max=${Math.max(1, Math.floor(duration))}
          step="1"
          value=${Math.floor(sample.time)}
          disabled=${!loaded || duration <= 0}
          aria-valuetext=${`${formatClock(sample.time)} of ${formatClock(duration)}`}
          onInput=${(/** @type {any} */ e) => onSeek(Number(e.currentTarget.value), false)}
          onChange=${(/** @type {any} */ e) => onSeek(Number(e.currentTarget.value), true)}
        />
      </div>

      <div class="button-row">
        <button onClick=${onTogglePlay} disabled=${!loaded} aria-pressed=${sample.playing}>
          ${sample.playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button
          class=${`danger ${channel.muted ? 'is-on' : ''}`}
          onClick=${onMute}
          disabled=${!loaded}
          aria-pressed=${channel.muted}
        >
          Kill
        </button>
        <button onClick=${onCue} disabled=${!loaded}>Set cue</button>
        ${channel.cues.map(
          (/** @type {number} */ at, /** @type {number} */ i) => html`
            <button key=${`${at}-${i}`} onClick=${() => onJumpCue(i)} title=${`Cue ${i + 1}`}>
              ${formatClock(at)}
            </button>
          `,
        )}
        ${channel.cues.length > 0 && html`<button onClick=${onClearCues}>Clear cues</button>`}
      </div>

      <div class="meter-wrap">
        <div class="field-label">
          <span>Fader gain</span>
          <span class="value">${gain <= 0.001 ? '−∞' : `${gainToDb(gain).toFixed(1)}`} dB · vol ${volume}</span>
        </div>
        <canvas
          ref=${canvasRef}
          role="img"
          aria-label=${`Deck ${upper} fader gain ${Math.round(gain * 100)} percent`}
        ></canvas>
      </div>

      ${Fader({
        id: `trim-${side}`,
        label: 'Trim',
        value: channel.trim,
        min: 0,
        max: 1,
        step: 0.01,
        display: `${Math.round(channel.trim * 100)}%`,
        valueText: `Deck ${upper} trim ${Math.round(channel.trim * 100)} percent`,
        onInput: onTrim,
      })}

      <div class="button-row">
        <label class="sr-only" for=${`bpm-${side}`}>Deck ${upper} BPM</label>
        <input
          id=${`bpm-${side}`}
          type="number"
          min="0"
          max="220"
          step="0.1"
          placeholder="BPM"
          value=${channel.bpm || ''}
          onInput=${(/** @type {any} */ e) => onBpm(Number(e.currentTarget.value))}
        />
        <button onClick=${onTap}>Tap</button>
        <button onClick=${onAnchor} disabled=${!loaded}>Downbeat here</button>
        <label class="sr-only" for=${`rate-${side}`}>Deck ${upper} playback rate</label>
        <select
          id=${`rate-${side}`}
          value=${String(sample.rate)}
          disabled=${!loaded}
          onChange=${(/** @type {any} */ e) => onRate(Number(e.currentTarget.value))}
        >
          ${rates.map((/** @type {number} */ r) => html`<option key=${r} value=${String(r)}>${r}×</option>`)}
        </select>
      </div>
    </section>
  `;
}

/**
 * The mixer column: crossfader, curve, master, sync.
 * @param {object} props
 */
export function MixerPanel({
  position,
  curve,
  master,
  fadeSeconds,
  sync,
  syncStatus,
  drift,
  phaseError,
  volumes,
  calls,
  wheelRef,
  curveRef,
  onPosition,
  onCurve,
  onMaster,
  onFadeSeconds,
  onAutoFade,
  onToggleSync,
  onSnap,
  onNudge,
  onAlign,
}) {
  const driftTone = !sync.enabled ? undefined : Math.abs(drift) < 0.1 ? 'good' : Math.abs(drift) < 0.5 ? 'warn' : 'bad';
  return html`
    <section class="mixer" aria-labelledby="mixer-title">
      <h2 id="mixer-title">Mixer</h2>

      ${Fader({
        className: 'crossfader',
        id: 'crossfader',
        label: 'Crossfader',
        value: position,
        min: 0,
        max: 1,
        step: 0.005,
        display: describePosition(position),
        valueText: describePosition(position),
        onInput: onPosition,
      })}
      <div class="crossfader-ends"><span>A</span><span>B</span></div>

      <canvas ref=${curveRef} role="img" aria-label=${`Crossfade curve, ${CURVE_LABELS[curve] ?? curve}`}></canvas>

      <div class="field">
        <label class="field-label" for="curve">
          <span>Curve</span>
        </label>
        <select id="curve" value=${curve} onChange=${(/** @type {any} */ e) => onCurve(e.currentTarget.value)}>
          ${CURVES.map((/** @type {string} */ c) => html`<option key=${c} value=${c}>${CURVE_LABELS[c]}</option>`)}
        </select>
      </div>

      ${Fader({
        id: 'master',
        label: 'Master',
        value: master,
        min: 0,
        max: 1,
        step: 0.01,
        display: `${Math.round(master * 100)}%`,
        valueText: `Master ${Math.round(master * 100)} percent`,
        onInput: onMaster,
      })}

      <hr />

      <h2>Auto-fade</h2>
      <div class="button-row">
        <button onClick=${() => onAutoFade('a')}>◀ To A</button>
        <button onClick=${() => onAutoFade('b')}>To B ▶</button>
        <label class="sr-only" for="fade-seconds">Auto-fade length in seconds</label>
        <input
          id="fade-seconds"
          type="number"
          min="0.5"
          max="120"
          step="0.5"
          value=${fadeSeconds}
          onInput=${(/** @type {any} */ e) => onFadeSeconds(Number(e.currentTarget.value))}
        />
      </div>

      <hr />

      <h2>Sync</h2>
      <canvas ref=${wheelRef} role="img" aria-label="Beat phase wheel for both decks"></canvas>
      <div class="button-row">
        <button class=${sync.enabled ? 'is-on' : ''} onClick=${onToggleSync} aria-pressed=${sync.enabled}>
          ${sync.enabled ? 'Sync on' : 'Sync off'}
        </button>
        <button onClick=${onSnap} disabled=${!sync.enabled}>Snap</button>
        <button onClick=${onAlign} disabled=${phaseError === null}>Align beats</button>
      </div>
      <div class="button-row">
        <button onClick=${() => onNudge(-0.25)}>−250 ms</button>
        <button onClick=${() => onNudge(-0.05)}>−50 ms</button>
        <button onClick=${() => onNudge(0.05)}>+50 ms</button>
        <button onClick=${() => onNudge(0.25)}>+250 ms</button>
      </div>

      <dl class="readout">
        <dt>Status</dt>
        <dd><span class="status-pill" data-tone=${driftTone}>${syncStatus}</span></dd>
        <dt>Drift</dt>
        <dd>${formatDrift(drift)}</dd>
        <dt>Offset</dt>
        <dd>${sync.offset >= 0 ? '+' : '−'}${Math.abs(sync.offset).toFixed(2)} s</dd>
        <dt>Beat phase</dt>
        <dd>${phaseError === null ? 'no BPM' : `${(phaseError * 100).toFixed(0)}%`}</dd>
        <dt>Corrections</dt>
        <dd>${sync.corrections}</dd>
        <dt>Volume A / B</dt>
        <dd>${volumes.a} / ${volumes.b}</dd>
        <dt>Player calls</dt>
        <dd>${calls}</dd>
      </dl>
    </section>
  `;
}

/**
 * @param {object} props
 * @param {string} props.theme
 * @param {(theme: string) => void} props.onTheme
 * @param {boolean} props.privacyMode
 * @param {() => void} props.onPrivacy
 */
export function TopBar({ theme, onTheme, privacyMode, onPrivacy }) {
  return html`
    <header class="topbar">
      <h1 class="brand">ytdj <small>two-deck console for YouTube</small></h1>
      <span class="spacer"></span>
      <div class="topbar-controls">
        <label class="sr-only" for="theme">Theme</label>
        <select id="theme" value=${theme} onChange=${(/** @type {any} */ e) => onTheme(e.currentTarget.value)}>
          ${THEMES.map((t) => html`<option key=${t.id} value=${t.id}>${t.label}</option>`)}
        </select>
        <button class=${privacyMode ? 'is-on' : ''} onClick=${onPrivacy} aria-pressed=${privacyMode}>
          ${privacyMode ? 'No-cookie embeds' : 'Standard embeds'}
        </button>
      </div>
    </header>
  `;
}

/**
 * @param {object} props
 * @param {{id: number, message: string, tone?: string}[]} props.toasts
 */
export function Toasts({ toasts }) {
  if (toasts.length === 0) return null;
  return html`
    <div class="toast-stack">
      ${toasts.map((t) => html`<div class="toast" key=${t.id} data-tone=${t.tone}>${t.message}</div>`)}
    </div>
  `;
}

/**
 * @param {object} props
 * @param {import('./shortcuts.js').Binding[]} props.table
 */
export function HelpPanels({ table }) {
  return html`
    <div class="panels">
      <section class="panel" aria-labelledby="keys-title">
        <h2 id="keys-title">Keyboard</h2>
        <ul class="shortcut-list">
          ${table.map(
            (b) => html`<li key=${b.keys}><span>${b.label}</span><kbd>${b.keys === ' ' ? 'Space' : b.keys}</kbd></li>`,
          )}
        </ul>
        <p>Shortcuts pause while you are typing in a field or dragging a fader.</p>
      </section>

      <section class="panel" aria-labelledby="limits-title">
        <h2 id="limits-title">What this cannot do</h2>
        <ul>
          <li>
            No spectrum analyser. The audio is inside a cross-origin iframe, so the page can
            never read samples from it. The meters here show the gain being applied, and the
            wheel shows the beat grid from the BPM you enter.
          </li>
          <li>
            No pitch bend, so no true beatmatching. The player accepts only the discrete
            rates it reports, usually quarter steps from 0.25× to 2×.
          </li>
          <li>
            Sync holds an offset, it does not lock a tempo. Seeks land to about a tenth of a
            second, so drift is corrected to roughly ±0.3 s and no finer.
          </li>
          <li>Audio cannot be isolated from video, downloaded, or recorded. That is by design.</li>
        </ul>
      </section>
    </div>
  `;
}

/** @param {{a: {videoId: string|null, title: string}, b: {videoId: string|null, title: string}}} props */
export function Legal({ a, b }) {
  const links = [a, b].filter((t) => t.videoId);
  return html`
    <footer class="legal">
      <p>
        Playback is handled entirely by YouTube's own embedded player, which stays visible with
        its controls intact. ytdj does not download, re-host, extract or record audio or video,
        and it blocks nothing the player shows you. Each video stays subject to its own
        licence and to the YouTube Terms of Service.
      </p>
      ${links.length > 0 &&
      html`<p>
        Now loaded:
        ${links.map(
          (t, i) => html`
            <span key=${t.videoId}
              >${i > 0 ? ' · ' : ' '}
              <a href=${`https://www.youtube.com/watch?v=${t.videoId}`} target="_blank" rel="noreferrer noopener"
                >${t.title || t.videoId} on YouTube</a
              ></span
            >
          `,
        )}
      </p>`}
    </footer>
  `;
}
