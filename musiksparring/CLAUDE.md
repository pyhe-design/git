# musiksparring

AI creative coach for musicians with a local-first AI SDK. UI copy is Danish. Overview and layout: `README.md`;
SDK API: `sdk/README.md`.

## Commands (run from this directory)

```sh
npm run lint                                                          # eslint: src, sdk, scripts, tests
npx eslint src/app.js                                                 # one file
npm test                                                              # SDK unit tests + Playwright smoke (index.html and dist/)
node --test --test-name-pattern='chord tokenizer' tests/sdk.test.mjs  # one unit test
npm run build                                                         # inline everything into dist/musiksparring_v3.html
npm run check                                                         # lint + build + test; run before committing
```

## Invariants

- `index.html` loads classic `<script>`s that share globals (`preact`, `preactHooks`, `htm`, `MusikAI`, `Theory`,
  `AudioKit`). `src/*.js` and `sdk/*.js` are scripts, not ES modules: no `import`/`export`. `scripts/` and `tests/`
  are ESM (`.mjs`).
- No build step in dev and no CDN scripts at runtime. `vendor/` holds pinned Preact/htm UMD builds: never edit or
  lint it.
- `dist/musiksparring_v3.html` is committed and smoke-tested: rebuild after any change to `index.html`, `src/`,
  `sdk/` or `vendor/`.
- `sdk/musiksparring-ai.js` is a zero-dependency UMD (browser global `MusikAI`, Node `require`; `sdk/package.json`
  forces CommonJS). Keep `sdk/musiksparring-ai.d.ts` and `sdk/README.md` in sync with its API.
- Anthropic requests: default model `claude-opus-5-5`. The static coach system prompt carries
  `cache_control: ephemeral` and project parameters go in the user turn, so the cached prefix stays stable. The smoke
  test asserts this request shape.
- The smoke test fails on any console error or warning, page error, failed request or HTTP status ≥ 400. Mock
  providers with `page.route`; tests never hit real endpoints.
- Playwright needs a browser: `npx playwright install chromium` locally, or `PW_CHROMIUM=/path/to/chrome` (set
  automatically in cloud sessions).
