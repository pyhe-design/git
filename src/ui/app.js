/** The application root. Owns the mixer, the decks and all UI state. */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { Deck } from '../engine/deck.js';
import { Mixer } from '../engine/mixer.js';
import { loadYouTubeApi } from '../engine/yt-loader.js';
import { parseVideoRef } from '../core/youtube-url.js';
import { createTapState, normalizeBpm, tap, tappedBpm } from '../core/tempo.js';
import { loadSession, resolveStorage, saveSession, THEMES } from '../core/store.js';
import { attachShortcuts, bindings } from './shortcuts.js';
import { startVizLoop } from './viz.js';
import { DeckPanel, HelpPanels, Legal, MixerPanel, Toasts, TopBar, html } from './components.js';

/** @type {('a'|'b')[]} */
const SIDES = ['a', 'b'];

/** Push a short-lived message into the toast stack. */
let toastId = 0;

/**
 * Announce something to screen readers through the shell's live region.
 * @param {string} message
 */
function announce(message) {
  const region = document.getElementById('live-region');
  if (region) region.textContent = message;
}

export function App() {
  const storage = useMemo(() => resolveStorage(), []);
  const initial = useMemo(() => loadSession(storage), [storage]);

  const [theme, setTheme] = useState(initial.theme);
  const [privacyMode, setPrivacyMode] = useState(initial.privacyMode);
  const [drafts, setDrafts] = useState({ a: '', b: '' });
  const [loading, setLoading] = useState({ a: false, b: false });
  const [tracks, setTracks] = useState({
    a: { videoId: initial.decks.a.videoId, title: initial.decks.a.title, author: initial.decks.a.author },
    b: { videoId: initial.decks.b.videoId, title: initial.decks.b.title, author: initial.decks.b.author },
  });
  const [rates, setRates] = useState({ a: [1], b: [1] });
  const [toasts, setToasts] = useState(/** @type {{id: number, message: string, tone?: string}[]} */ ([]));
  const [apiError, setApiError] = useState(/** @type {string|null} */ (null));

  // The mixer is mutable and ticks 15 times a second; a reducer bump is cheaper
  // than mirroring its whole state into Preact on every tick.
  const [, bump] = useReducer((/** @type {number} */ n) => n + 1, 0);

  const stageRefs = { a: useRef(null), b: useRef(null) };
  const meterRefs = { a: useRef(null), b: useRef(null) };
  const timelineRefs = { a: useRef(null), b: useRef(null) };
  const wheelRef = useRef(null);
  const curveRef = useRef(null);
  const tapRef = useRef({ a: createTapState(), b: createTapState() });

  /**
   * @param {string} message
   * @param {string} [tone]
   */
  const toast = useCallback((message, tone) => {
    toastId += 1;
    const id = toastId;
    setToasts((list) => [...list.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 5200);
  }, []);

  const mixer = useMemo(
    () =>
      new Mixer({
        session: initial,
        onEvent: (event, payload) => {
          if (event === 'announce') announce(payload.message);
        },
      }),
    [initial],
  );

  // ----------------------------------------------------------------- lifecycle

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const unsubscribe = mixer.subscribe(bump);
    mixer.start();
    return () => {
      unsubscribe();
      mixer.stop();
      for (const side of SIDES) mixer.decks[side]?.destroy();
    };
  }, [mixer, bump]);

  // Persist on a debounce: the mixer mutates far faster than storage should see.
  useEffect(() => {
    const timer = setTimeout(() => {
      saveSession(storage, {
        version: 1,
        theme,
        curve: mixer.curve,
        master: mixer.master,
        position: mixer.position,
        fadeSeconds: mixer.fadeSeconds,
        privacyMode,
        decks: {
          a: { ...tracks.a, ...mixer.channels.a },
          b: { ...tracks.b, ...mixer.channels.b },
        },
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [storage, theme, privacyMode, tracks, mixer, mixer.position, mixer.master, mixer.curve]);

  // ---------------------------------------------------------------- loading

  /**
   * SIDE EFFECT: one fetch to our own /api/resolve, which proxies YouTube's
   * oEmbed endpoint. Failure is non-fatal; the player supplies the title later.
   * @param {string} input
   * @returns {Promise<{videoId: string, start: number, title: string, author: string}|null>}
   */
  const resolveMeta = useCallback(async (input) => {
    const ref = parseVideoRef(input);
    if (!ref) return null;
    try {
      const response = await fetch(`/api/resolve?url=${encodeURIComponent(input)}`, {
        headers: { accept: 'application/json' },
      });
      const data = await response.json();
      if (!response.ok) {
        toast(data.message ?? 'That video could not be loaded.', 'bad');
        return null;
      }
      return { videoId: ref.id, start: data.start ?? ref.start, title: data.title ?? '', author: data.author ?? '' };
    } catch {
      return { videoId: ref.id, start: ref.start, title: '', author: '' };
    }
  }, [toast]);

  /**
   * @param {'a'|'b'} side
   * @param {string} [input]
   */
  const loadDeck = useCallback(
    async (side, input = drafts[side]) => {
      const ref = parseVideoRef(input);
      if (!ref) {
        toast('That is not a YouTube link or video id.', 'bad');
        return;
      }
      setLoading((s) => ({ ...s, [side]: true }));
      try {
        const meta = (await resolveMeta(input)) ?? { videoId: ref.id, start: ref.start, title: '', author: '' };
        const YT = await loadYouTubeApi();
        let deck = mixer.decks[side];
        // The embed host is fixed when the iframe is built, so a privacy-mode
        // change only takes effect by rebuilding the player.
        if (deck && deck.privacyMode !== privacyMode) {
          deck.destroy();
          mixer.decks[side] = null;
          deck = null;
        }
        if (!deck) {
          const container = stageRefs[side].current;
          if (!container) return;
          deck = new Deck({
            id: side,
            container,
            YT,
            privacyMode,
            onEvent: (event, payload) => {
              if (event === 'error') toast(`Deck ${side.toUpperCase()}: ${payload.message}`, 'bad');
              if (event === 'ready' || event === 'loaded') {
                setRates((r) => ({ ...r, [side]: mixer.decks[side]?.availableRates() ?? [1] }));
              }
            },
          });
          mixer.attach(side, deck);
          await deck.create(meta.videoId, meta.start);
        } else {
          await deck.load(meta.videoId, meta.start);
        }
        // The player knows its own title, so prefer it over the proxy's answer.
        const fromPlayer = deck.metadata();
        setTracks((t) => ({
          ...t,
          [side]: {
            videoId: meta.videoId,
            title: meta.title || fromPlayer?.title || '',
            author: meta.author || fromPlayer?.author || '',
          },
        }));
        setRates((r) => ({ ...r, [side]: deck.availableRates() }));
        mixer.applyGains();
        announce(`Deck ${side.toUpperCase()} loaded${meta.title ? `: ${meta.title}` : ''}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error loading the deck.';
        setApiError((prev) => prev ?? (message.includes('IFrame API') ? message : null));
        toast(message, 'bad');
      } finally {
        setLoading((s) => ({ ...s, [side]: false }));
      }
    },
    [drafts, mixer, privacyMode, resolveMeta, toast],
  );

  // Titles can land after the player settles; pick them up once.
  useEffect(() => {
    const timer = setInterval(() => {
      for (const side of SIDES) {
        if (!tracks[side].videoId || tracks[side].title) continue;
        const meta = mixer.decks[side]?.metadata();
        if (meta?.title) {
          setTracks((t) => ({ ...t, [side]: { ...t[side], title: meta.title, author: meta.author } }));
        }
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [mixer, tracks]);

  // ------------------------------------------------------------------ actions

  /** @param {'a'|'b'} side */
  const onTap = useCallback(
    (side) => {
      const next = tap(tapRef.current[side], Date.now());
      tapRef.current = { ...tapRef.current, [side]: next };
      const bpm = tappedBpm(next);
      if (bpm === null) {
        announce(`Tap ${next.taps.length} on deck ${side.toUpperCase()}`);
        return;
      }
      mixer.setBpm(side, normalizeBpm(bpm));
      announce(`Deck ${side.toUpperCase()} ${normalizeBpm(bpm)} BPM`);
    },
    [mixer],
  );

  const actions = useMemo(
    () => ({
      togglePlay: (/** @type {'a'|'b'} */ side) => mixer.decks[side]?.togglePlay(),
      cue: (/** @type {'a'|'b'} */ side) => mixer.jumpToCue(side, 0),
      toggleMute: (/** @type {'a'|'b'} */ side) => mixer.toggleMute(side),
      moveFader: (/** @type {number} */ delta) => mixer.setPosition(mixer.position + delta),
      autoFade: (/** @type {'a'|'b'} */ side) => mixer.startAutoFade(side),
      toggleSync: () => mixer.toggleSync(),
      alignBeats: () => {
        if (!mixer.alignBeats()) toast('Set a BPM on both decks first.', 'warn');
      },
      nudge: (/** @type {number} */ delta) => mixer.nudge(delta),
      tap: onTap,
    }),
    [mixer, onTap, toast],
  );

  const table = useMemo(() => bindings(actions), [actions]);

  useEffect(() => attachShortcuts(globalThis, table), [table]);

  // ---------------------------------------------------------------- visuals

  useEffect(() => {
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const stop = startVizLoop(() => {
      const fades = mixer.fadeGains();
      /** @type {any} */
      const decks = {};
      for (const side of SIDES) {
        const s = mixer.samples[side];
        decks[side] = {
          time: s.time,
          duration: s.duration,
          playing: s.playing,
          rate: s.rate,
          sampledAt: s.sampledAt,
          bpm: mixer.channels[side].bpm,
          anchor: mixer.channels[side].anchor,
          cues: mixer.channels[side].cues,
          gain: mixer.channels[side].muted ? 0 : fades[side] * mixer.channels[side].trim * mixer.master,
        };
      }
      return {
        position: mixer.position,
        curve: mixer.curve,
        decks,
        targets: {
          curve: curveRef.current,
          wheel: wheelRef.current,
          'meter-a': meterRefs.a.current,
          'meter-b': meterRefs.b.current,
          'timeline-a': timelineRefs.a.current,
          'timeline-b': timelineRefs.b.current,
        },
      };
    }, !reduced);
    return stop;
  }, [mixer]);

  // ------------------------------------------------------------------- render

  const fades = mixer.fadeGains();
  const volumes = mixer.volumes();

  /**
   * Everything one deck column needs. Built here so deck A and deck B are wired
   * identically and can never drift apart.
   * @param {'a'|'b'} side
   */
  const deckProps = (side) => ({
    key: side,
    side,
    draft: drafts[side],
    onDraft: (/** @type {string} */ v) => setDrafts((d) => ({ ...d, [side]: v })),
    onLoad: () => loadDeck(side),
    loading: loading[side],
    track: tracks[side],
    sample: mixer.samples[side],
    channel: mixer.channels[side],
    gain: mixer.channels[side].muted ? 0 : fades[side] * mixer.channels[side].trim * mixer.master,
    volume: volumes[side],
    rates: rates[side],
    onTogglePlay: () => mixer.decks[side]?.togglePlay(),
    onSeek: (/** @type {number} */ t, /** @type {boolean} */ commit) => mixer.decks[side]?.seek(t, commit),
    onTrim: (/** @type {number} */ v) => mixer.setTrim(side, v),
    onMute: () => mixer.toggleMute(side),
    onTap: () => onTap(side),
    onBpm: (/** @type {number} */ v) => mixer.setBpm(side, v),
    onAnchor: () => mixer.setAnchorHere(side),
    onCue: () => mixer.addCue(side),
    onJumpCue: (/** @type {number} */ i) => mixer.jumpToCue(side, i),
    onClearCues: () => mixer.clearCues(side),
    onRate: (/** @type {number} */ r) => mixer.decks[side]?.setRate(r),
    canvasRef: meterRefs[side],
    timelineRef: timelineRefs[side],
    stageRef: stageRefs[side],
  });

  return html`
    <div class="shell">
      ${TopBar({
        theme,
        onTheme: (/** @type {string} */ value) => {
          setTheme(THEMES.some((t) => t.id === value) ? value : 'midnight');
          announce(`Theme ${value}`);
        },
        privacyMode,
        onPrivacy: () => {
          const next = !privacyMode;
          setPrivacyMode(next);
          mixer.privacyMode = next;
          toast(
            next
              ? 'Embeds will use youtube-nocookie.com. Reload a deck to apply it.'
              : 'Embeds will use youtube.com. Reload a deck to apply it.',
            'warn',
          );
        },
      })}

      ${apiError &&
      html`<div class="panel" role="alert"><h2>Player unavailable</h2><p>${apiError}</p></div>`}

      <div class="console">
        ${DeckPanel(deckProps('a'))}
        ${MixerPanel({
          position: mixer.position,
          curve: mixer.curve,
          master: mixer.master,
          fadeSeconds: mixer.fadeSeconds,
          sync: mixer.sync,
          syncStatus: mixer.syncStatus,
          drift: mixer.drift,
          phaseError: mixer.phaseError(),
          volumes,
          calls: mixer.callCount(),
          wheelRef,
          curveRef,
          onPosition: (/** @type {number} */ v) => mixer.setPosition(v),
          onCurve: (/** @type {string} */ v) => mixer.setCurve(v),
          onMaster: (/** @type {number} */ v) => mixer.setMaster(v),
          onFadeSeconds: (/** @type {number} */ v) => {
            mixer.fadeSeconds = Math.max(0.5, Math.min(120, v));
            bump();
          },
          onAutoFade: (/** @type {'a'|'b'} */ s) => mixer.startAutoFade(s),
          onToggleSync: () => mixer.toggleSync(),
          onSnap: () => mixer.snapToLock(),
          onNudge: (/** @type {number} */ d) => mixer.nudge(d),
          onAlign: () => actions.alignBeats(),
        })}
        ${DeckPanel(deckProps('b'))}
      </div>

      ${HelpPanels({ table })}
      ${Legal({ a: tracks.a, b: tracks.b })}
      ${Toasts({ toasts })}
    </div>
  `;
}
