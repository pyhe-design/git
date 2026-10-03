# ytdj

A two-deck DJ console for YouTube videos. Load two links, mix them with an
equal-power crossfader, and hold them in time with an offset lock.

```sh
npm install   # dev tooling only; the app itself ships with its dependencies vendored
npm start     # http://127.0.0.1:8080
npm run check # lint + 67 unit/server tests + 33 end-to-end checks
```

## Read this before you build on it

Three things are impossible with an embedded YouTube player, and most "YouTube
DJ" projects quietly pretend otherwise. They shape every design decision here.

**You cannot touch the audio.** The player is a cross-origin iframe. There is no
`MediaElementSource`, no `GainNode`, no `AnalyserNode`, and no way to obtain a
single sample. So:

- Crossfading is done with `setVolume(0..100)` on each player, an integer
  delivered by `postMessage`, not with a Web Audio gain graph.
- There is no spectrum analyser in this app and there cannot be one. The meters
  show the gain being applied; the wheel shows a beat grid derived from a BPM
  you supply. Anything drawn as a "spectrum" over a YouTube embed is invented.

**You cannot pitch bend, so you cannot truly beatmatch.** `setPlaybackRate`
accepts only the discrete rates `getAvailablePlaybackRates()` reports, normally
quarter steps from 0.25x to 2x. There is no 0.3% nudge, so two tracks at 128 and
130 BPM cannot be pulled into agreement. What this app offers instead is an
offset lock plus a visible beat-phase wheel and manual nudges.

**Seeks are coarse.** `seekTo` lands to roughly a tenth of a second and makes
the player re-buffer, which is audible. The drift corrector therefore runs with
a 0.3 s deadband and a 1.2 s cooldown: correcting small drift costs more than
living with it.

## How it works

```
index.html ──importmap──> vendor/{preact,preact-hooks,htm}.module.js
    │
    └── src/main.js
         └── ui/app.js ──────> engine/mixer.js ──> engine/deck.js ──> YT.Player
              │                      │                 (postMessage to the iframe)
              │                      └──> core/{crossfade,sync,tempo}.js  (pure)
              ├── ui/components.js   (presentational only)
              ├── ui/viz.js          (one rAF loop, four canvases)
              └── ui/shortcuts.js

server/ ── static files + /api/resolve (oEmbed proxy) + /api/setlists
```

`src/core/` is pure: no DOM, no network, no timers. That is where the crossfade
curves, the drift decisions, the tap-tempo median and the session schema live,
and it is where almost all of the test value is. `src/engine/` is the only code
that touches a player. `src/ui/` never touches one.

### Keeping the call count down

Every player method crosses an iframe boundary, so the app budgets them:

| Decision | Effect |
| --- | --- |
| One shared 15 Hz poll loop for both decks | not one timer per deck, and not one per frame |
| Volume writes coalesced into one per animation frame, skipped when the integer is unchanged | a 51-step fader sweep produced 43 writes across both decks, not 102 |
| Canvases extrapolate the playhead from the last sample's timestamp | 60 fps animation at zero extra player calls |
| Drift corrector deadbanded and rate-limited | a 3 s drift costs one seek, not a stream of them |

The console shows a live **Player calls** counter so a regression here is visible
while you work.

### Crossfade curves

| Curve | Centre | Use |
| --- | --- | --- |
| Equal power | -3.0 dB both decks | default; summed power stays constant, so no dip through the middle |
| Linear | -6.0 dB both decks | the naive curve, included for comparison |
| Sharp cut | both fully open | scratch-style; cuts only in the last 15% of travel at each end |

### Sync

Hitting SYNC captures `offset = followerTime - leaderTime` and holds it. Each
tick the corrector compares actual drift against the lock and decides:

- within 0.3 s, do nothing (seeking would cost more than the drift)
- beyond it but under 5 s, and not within 1.2 s of the last correction, seek the
  follower to `leaderTime + offset`
- beyond 5 s, assume the user scrubbed and release the lock rather than fight them

**Align beats** uses the two BPMs to compute the offset trim that puts the
follower's beat on the leader's. It needs a BPM on both decks; tap it in with
`e` and `i`, or type it.

## Server

Node core only, no Express. Two endpoints do real server-side work:

- `GET /api/resolve?url=…` — **external API call** to YouTube's public oEmbed
  endpoint for title, channel and thumbnail. Server-side because the browser
  cannot read that response cross-origin, and because one cache serves every
  client. No API key, no quota. If it is unreachable the endpoint degrades to a
  200 with `degraded: true` and the player supplies the title instead.
- `GET`/`PUT /api/setlists` — **side effect**: reads and writes
  `data/setlists.json`, written via temp file and rename so a crash cannot
  truncate it. Payloads are capped at 64 KB and 50 sets.

The CSP is strict and two parts of it are load-bearing:

- `script-src` must allow `www.youtube.com` and `s.ytimg.com`, or the IFrame API
  cannot load. It also carries a SHA-256 hash of the inline import map, computed
  from `index.html` at boot so it cannot drift. Do not replace that with
  `'unsafe-inline'`.
- `referrer-policy` must still send an origin. With `no-referrer` the player
  fails with error 153.

## Terms of service and licensing

Playback is handled entirely by YouTube's own embedded player.

- The player stays visible at all times, never smaller than 200x200, never
  `display: none`, never covered by an overlay.
- Nothing is downloaded, re-hosted, extracted, recorded or proxied. There is no
  audio-only mode, because producing one would mean circumventing the player.
- Nothing the player shows is blocked or hidden, advertising included.
- Each loaded video keeps a visible attribution link back to its YouTube page.
- Embeds default to `youtube-nocookie.com`; the topbar can switch to the standard
  host.

Each video remains subject to its own licence and to the YouTube Terms of
Service. A public DJ set made of other people's recordings is a licensing
question between you and the rights holders, and this tool does not change that.

## Accessibility

- Every control is a real `button`, `input` or `select` with an accessible name.
  The end-to-end suite fails the build if any control loses one.
- Sliders carry `aria-valuetext`, so the crossfader announces "Both decks equal"
  rather than "0.5".
- State changes (deck loaded, sync locked, auto-fade finished, BPM tapped) are
  announced through a polite live region.
- Keyboard shortcuts cover the whole transport and stand down whenever focus is
  in a text field or on a slider.
- 44 px touch targets below 820 px, no horizontal scroll at 390 px, and
  `prefers-reduced-motion` switches the canvases from 60 fps to 4 fps.

## Keyboard

| | Deck A | Deck B |
| --- | --- | --- |
| Play / pause | <kbd>q</kbd> | <kbd>p</kbd> |
| Jump to first cue | <kbd>a</kbd> | <kbd>l</kbd> |
| Kill | <kbd>w</kbd> | <kbd>o</kbd> |
| Tap tempo | <kbd>e</kbd> | <kbd>i</kbd> |
| Auto-fade to | <kbd>1</kbd> | <kbd>2</kbd> |

Crossfade with <kbd>←</kbd> and <kbd>→</kbd>, toggle sync with <kbd>s</kbd>,
align beats with <kbd>d</kbd>, nudge the follower with <kbd>[</kbd> and
<kbd>]</kbd>.

## Tests

| Suite | What it covers |
| --- | --- |
| `tests/core.test.mjs` | 41 tests over the pure modules: URL shapes and rejections, curve power laws, gain quantisation, every drift-correction branch, tap-tempo median and folding, session coercion against hostile payloads |
| `tests/server.test.mjs` | 26 tests: traversal containment, ETag/304, the CSP's load-bearing directives, oEmbed caching and degradation, atomic setlist writes, 400/405/413 handling |
| `tests/smoke.mjs` | 33 end-to-end checks in Chromium, with `iframe_api` routed to a stub so no network or real playback is needed |

The smoke test asserts things unit tests cannot: that the fader lands the right
integers on real player objects, that a sweep is coalesced, that the corrector
issues a seek and then stops, that the players stay visibly sized, and that the
layout and labelling hold up at phone width.

`SMOKE_SHOTS=/some/dir npm run test:smoke` also writes screenshots.

### Deviations from the brief

- **Preact, not React or Vue.** Same hooks API, 11 kB, vendored as ESM, so the
  app runs with no build step and no `node_modules` at runtime. Swapping in React
  means changing only the import map.
- **`node:test`, not Jest.** Identical coverage with one fewer dependency tree,
  and it matches the "minimal external dependencies" rule. Playwright stays,
  because the behaviour worth testing here only exists in a browser.
- **No bundler.** Native ES modules over HTTP plus an import map. The server the
  brief asked for is already there to serve them.

## Licence

MIT, see [LICENSE](LICENSE). Vendored Preact and htm are MIT, copied verbatim;
see `vendor/VERSIONS`.
