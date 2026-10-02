# MusikSparring Pro v3

AI creative coach for musicians with a built-in studio toolkit — local-first.

- **Input** – describe the project (genre, mood, BPM, key, references, material, constraints, goals) and generate a
  structured plan: clarifying questions, directions, chord progressions, melodic ideas, grooves, arrangement, mix tips,
  lyric angles and next steps.
- **Værktøjer** – Scale Lab (two-octave piano, 12-fret tone map, diatonic chords), Chord Lab (any chord symbol → piano
  voicing + guitar shape with barré, progression playback) and Rhythm Lab (16-step sequencer, swing, tap tempo,
  presets, per-track mute).
- **Resultater** – every progression is playable; chords open in Chord Lab inline; export as Markdown or JSON.
- **Historik** – last 20 sessions, stored in the browser only.
- **AI** – Demo (offline), Ollama, LM Studio, any OpenAI-compatible server, Anthropic Claude, OpenAI. Keys never leave
  the browser except to the provider you pick.

No build step and no CDN at runtime: Preact + htm are vendored, everything else is plain JS/CSS.

## Run

```
open index.html                     # from a local server or file://
npm run build                       # → dist/musiksparring_v3.html (single self-contained file)
```

Local AI: `OLLAMA_ORIGINS="*" ollama serve`, then pick *Ollama* under ⚙ AI and press *Test forbindelse*.

## Develop

```
npm install
npm run lint                        # eslint (src, sdk, scripts, tests)
npm run build                       # inline everything into dist/
npm test                            # SDK unit tests + headless UI smoke test (Playwright)
PW_CHROMIUM=/path/to/chrome npm test   # reuse a pre-installed Chromium
SMOKE_SHOTS=./shots npm test        # also save screenshots
```

The smoke test serves the project, drives every view (demo generation, chord/scale/rhythm labs, settings, mocked
Ollama and Anthropic round-trips, history, keyboard shortcuts, mobile viewport) and fails on any console error,
page error, failed request or assertion — for both `index.html` and the built single file.

Layout:

```
index.html            entry (dev)
src/app.js            UI (Preact + htm)
src/theory.js         scales, chords, keys, roman numerals, guitar shapes
src/audio.js          Web Audio synth, drums, lookahead sequencer
src/styles.css        design system
sdk/                  MusikSparring AI SDK (see sdk/README.md)
vendor/               preact 10, preact/hooks, htm 3 (UMD)
scripts/build.mjs     single-file bundler
tests/                sdk.test.mjs (node:test), smoke.mjs (playwright)
dist/                 built single-file app
```

Keyboard: `1–4` switch tabs, `,` opens AI settings, `Ctrl/Cmd+Enter` generates.
