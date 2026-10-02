# MusikSparring AI SDK

Zero-dependency LLM client for musicians' tools. Local-first: Ollama, LM Studio and any
OpenAI-compatible server work without an API key; Anthropic and OpenAI are opt-in cloud providers.
One file, works as a classic `<script>` in the browser and via `require()` in Node ≥ 18.

```html
<script src="sdk/musiksparring-ai.js"></script>
<script>
  const ai = MusikAI.createClient({ provider: 'ollama', model: 'llama3.1' });
  const { suggestions } = await ai.generateSuggestions({ genre: 'lo-fi', key: 'Am', bpm: '84' });
</script>
```

```js
// Node (CommonJS or ESM via createRequire)
const AI = require('./sdk/musiksparring-ai.js');
const ai = AI.createClient({ provider: 'lmstudio', model: 'qwen2.5-7b-instruct' });
const { data } = await ai.generateJSON({ system: 'Answer as JSON', prompt: 'Three song titles', schema: { type: 'object', properties: { titles: { type: 'array', items: { type: 'string' } } }, required: ['titles'], additionalProperties: false } });
```

## Providers

| id | Default base URL | Key | Structured output |
|----|------------------|-----|-------------------|
| `demo` | – | no | deterministic offline mock |
| `ollama` | `http://localhost:11434` | no | `format: <json schema>` |
| `lmstudio` | `http://localhost:1234/v1` | no | `response_format: json_schema` |
| `openai_compatible` | `http://localhost:8080/v1` | optional | `response_format: json_object`, auto-fallback to plain |
| `anthropic` | `https://api.anthropic.com` | `sk-ant-…` | `output_config.format` (json_schema), system prompt cached |
| `openai` | `https://api.openai.com/v1` | `sk-…` | `response_format: json_schema` (strict) |

Browser CORS for local servers:

- Ollama: `OLLAMA_ORIGINS="*" ollama serve`
- LM Studio: Developer → Server Settings → *Enable CORS*
- llama.cpp: `llama-server --cors` (or set `MS_BASE_URL` to a proxy)

## API

- `createClient(config)` → `Client` — `provider`, `model`, `baseUrl`, `apiKey`, `timeoutMs` (120 s), `maxRetries` (2), `temperature` (0.8), `effort` (Anthropic, `medium`), `fetch` (injectable).
- `client.chat({ system, prompt | messages, json, schema, temperature, maxTokens, signal })` → `{ text, model, usage, durationMs }`
- `client.generateJSON(req)` → `{ data, meta }` — tolerant parsing (code fences, surrounding prose).
- `client.generateSuggestions(params, { signal })` → `{ suggestions, meta }` — validated, normalised `Suggestions`.
- `client.listModels()` / `client.ping()` — connectivity + model discovery (`ping` never throws).
- `client.validate()` — throws `MusikAIError` with `code` in `missing_key | bad_key | missing_model | config`.
- `buildCoachPrompt(params)`, `normalizeSuggestions(raw)`, `parseJSONLoose(text)`, `mockSuggestions(params)`, `suggestionsToMarkdown(s, params)`
- `theory.{normalizeNote, transpose, parseKey, diatonicChords, tokenizeChords}`

Errors are always `MusikAIError` with `code`, `status`, `provider`, `retryable`. Retries: 429 / 408 / 5xx / network with
backoff and `Retry-After`. Abort via `AbortSignal`. Servers that reject structured output get one retry in plain mode.

### Anthropic specifics

Model default `claude-opus-5-5`, adaptive thinking (no `thinking` field sent), `output_config.effort`, structured
output through `output_config.format`, `stop_reason: "refusal"` surfaced as `code: 'refusal'`. The static coach
system prompt is sent first with `cache_control: { type: 'ephemeral' }`; project parameters go in the user turn so the
prefix stays cacheable. Direct browser calls send `anthropic-dangerous-direct-browser-access: true` — only do this
on your own machine.

## CLI

```
node sdk/examples/node-cli.mjs --genre "indie pop" --key Am --bpm 104            # demo, offline
MS_PROVIDER=ollama MS_MODEL=llama3.1 node sdk/examples/node-cli.mjs --list       # model discovery
MS_PROVIDER=ollama MS_MODEL=llama3.1 node sdk/examples/node-cli.mjs --genre house --json
```

Types: `musiksparring-ai.d.ts`. Tests: `node --test tests/sdk.test.mjs`.
