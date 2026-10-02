/* Unit tests for the SDK (Node ≥ 18, no deps). Run: node --test tests/ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AI = require('../sdk/musiksparring-ai.js');

const fakeFetch = (handler) => async (url, init) => {
  const r = await handler(url, init);
  const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  return {
    ok: (r.status || 200) < 400,
    status: r.status || 200,
    headers: { get: (k) => (r.headers || {})[k.toLowerCase()] ?? null },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
};

const sample = {
  summary: 'ok', questions: ['q'], directions: ['d'],
  chords: [{ label: 'L', chords: ['C', 'G', 'Am', 'F'], note: 'n' }],
  melodies: ['m'], rhythm: ['r'], arrangement: ['a'], production: ['p'], lyrics: ['l'], actions: ['x'],
};

test('theory: note normalisation, keys, diatonic chords', () => {
  const t = AI.theory;
  assert.equal(t.normalizeNote('Bb'), 'A#');
  assert.equal(t.normalizeNote('e#'), 'F');
  assert.equal(t.transpose('G', 5), 'C');
  assert.deepEqual(t.parseKey('F# mol'), { root: 'F#', mode: 'minor' });
  assert.deepEqual(t.parseKey('Bb dur'), { root: 'A#', mode: 'major' });
  assert.deepEqual(t.parseKey('Am'), { root: 'A', mode: 'minor' });
  assert.deepEqual(t.parseKey('C'), { root: 'C', mode: 'major' });
  assert.deepEqual(t.diatonicChords('C', 'major'), ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']);
  assert.deepEqual(t.diatonicChords('A', 'minor'), ['Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G']);
});

test('theory: chord tokenizer', () => {
  const t = AI.theory;
  assert.deepEqual(t.tokenizeChords('Am - F - C - G'), ['Am', 'F', 'C', 'G']);
  assert.deepEqual(t.tokenizeChords('Try Dm7 → G7 → Cmaj7 here'), ['Dm7', 'G7', 'Cmaj7']);
  assert.deepEqual(t.tokenizeChords('Bbmaj7/D then F#m'), ['A#maj7/D', 'F#m']);
  assert.deepEqual(t.tokenizeChords('A single word'), [], 'lone letter in prose is not a chord');
  assert.deepEqual(t.tokenizeChords('F', { allowBare: true }), ['F']);
});

test('normalizeSuggestions accepts strings, objects and legacy shapes', () => {
  const n = AI.normalizeSuggestions({
    questions: '1. Hvem?\n2. Hvad?',
    chords: ['Vers: Am - F - C - G', { name: 'Chorus', progression: 'C G Am F', why: 'classic' }, 'no chords here'],
    actions: [{ step: 1 }],
  });
  assert.deepEqual(n.questions, ['Hvem?', 'Hvad?']);
  assert.equal(n.chords.length, 3);
  assert.deepEqual(n.chords[0], { label: 'Vers', chords: ['Am', 'F', 'C', 'G'], note: 'Vers: Am - F - C - G' });
  assert.deepEqual(n.chords[1], { label: 'Chorus', chords: ['C', 'G', 'Am', 'F'], note: 'classic' });
  assert.deepEqual(n.chords[2].chords, []);
  assert.equal(n.actions[0], '{"step":1}');
  assert.deepEqual(n.melodies, []);
});

test('parseJSONLoose handles fences and surrounding prose', () => {
  assert.deepEqual(AI.parseJSONLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(AI.parseJSONLoose('Here you go: {"a":[1,2]} cheers'), { a: [1, 2] });
  assert.throws(() => AI.parseJSONLoose('nothing'), /JSON/);
});

test('mockSuggestions is deterministic and key-aware', () => {
  const a = AI.mockSuggestions({ key: 'Am', genre: 'lofi' });
  const b = AI.mockSuggestions({ key: 'Am', genre: 'lofi' });
  assert.deepEqual(a, b);
  assert.deepEqual(a.chords[0].chords, ['Am', 'F', 'C', 'G']);
  const c = AI.mockSuggestions({ key: 'D dur' });
  assert.deepEqual(c.chords[0].chords, ['D', 'A', 'Bm', 'G']);
});

test('buildCoachPrompt keeps the system prompt stable (cacheable prefix)', () => {
  const p1 = AI.buildCoachPrompt({ genre: 'pop' });
  const p2 = AI.buildCoachPrompt({ genre: 'jazz', bpm: '120' });
  assert.equal(p1.system, p2.system);
  assert.match(p2.user, /Genre: jazz/);
  assert.match(p2.user, /BPM: 120/);
  assert.match(p1.user, /Toneart: ikke angivet/);
});

test('demo client works offline', async () => {
  const c = AI.createClient({ provider: 'demo' });
  const { suggestions, meta } = await c.generateSuggestions({ key: 'Em', genre: 'house' });
  assert.equal(meta.provider, 'demo');
  assert.equal(suggestions.chords[0].chords[0], 'Em');
  assert.deepEqual(await c.listModels(), ['demo']);
});

test('validation: missing key / bad prefix / unknown provider', async () => {
  assert.throws(() => AI.createClient({ provider: 'nope' }), /Ukendt provider/);
  const a = AI.createClient({ provider: 'anthropic', fetch: fakeFetch(() => ({ body: {} })) });
  await assert.rejects(() => a.chat({ prompt: 'x' }), (e) => e.code === 'missing_key');
  const b = AI.createClient({ provider: 'anthropic', apiKey: 'sk-wrong', fetch: fakeFetch(() => ({ body: {} })) });
  await assert.rejects(() => b.chat({ prompt: 'x' }), (e) => e.code === 'bad_key');
  const o = AI.createClient({ provider: 'lmstudio', fetch: fakeFetch(() => ({ body: {} })) });
  await assert.rejects(() => o.chat({ prompt: 'x' }), (e) => e.code === 'missing_model');
});

test('ollama adapter: request shape, structured format, usage mapping', async () => {
  let captured;
  const c = AI.createClient({
    provider: 'ollama', model: 'llama3.1', fetch: fakeFetch((url, init) => {
      captured = { url, body: JSON.parse(init.body), headers: init.headers };
      return { body: { model: 'llama3.1', message: { content: JSON.stringify(sample) }, prompt_eval_count: 10, eval_count: 5 } };
    }),
  });
  const { suggestions, meta } = await c.generateSuggestions({ genre: 'pop' });
  assert.equal(captured.url, 'http://localhost:11434/api/chat');
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.format.type, 'object');
  assert.equal(captured.body.messages[0].role, 'system');
  assert.equal(captured.headers.authorization, undefined);
  assert.deepEqual(meta.usage, { input_tokens: 10, output_tokens: 5 });
  assert.deepEqual(suggestions.chords[0].chords, ['C', 'G', 'Am', 'F']);
});

test('anthropic adapter: headers, cache_control, structured output, refusal', async () => {
  let captured;
  const mk = (resp) => AI.createClient({
    provider: 'anthropic', apiKey: 'sk-ant-abc', effort: 'low',
    fetch: fakeFetch((url, init) => { captured = { url, body: JSON.parse(init.body), headers: init.headers }; return resp; }),
  });
  const ok = mk({ body: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(sample) }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const { meta } = await ok.generateSuggestions({});
  assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured.headers['x-api-key'], 'sk-ant-abc');
  assert.equal(captured.headers['anthropic-version'], '2023-06-01');
  assert.equal(captured.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(captured.body.model, 'claude-opus-5-5');
  assert.equal(captured.body.system[0].cache_control.type, 'ephemeral');
  assert.equal(captured.body.output_config.effort, 'low');
  assert.equal(captured.body.output_config.format.type, 'json_schema');
  assert.equal(captured.body.thinking, undefined, 'thinking is adaptive by default; never send a budget');
  assert.equal(meta.model, 'claude-opus-5-5');

  const refused = mk({ body: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] } });
  await assert.rejects(() => refused.generateSuggestions({}), (e) => e.code === 'refusal' && /cyber/.test(e.message));
});

test('openai adapter: json_schema strict + bearer auth', async () => {
  let captured;
  const c = AI.createClient({
    provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o',
    fetch: fakeFetch((url, init) => { captured = { url, body: JSON.parse(init.body), headers: init.headers }; return { body: { model: 'gpt-4o', choices: [{ message: { content: JSON.stringify(sample) } }] } }; }),
  });
  await c.generateSuggestions({});
  assert.equal(captured.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(captured.headers.authorization, 'Bearer sk-x');
  assert.equal(captured.body.response_format.type, 'json_schema');
  assert.equal(captured.body.response_format.json_schema.strict, true);
});

test('retries 429/5xx with retry-after, then surfaces a typed error', async () => {
  let calls = 0;
  const c = AI.createClient({
    provider: 'lmstudio', model: 'm', maxRetries: 2,
    fetch: fakeFetch(() => { calls += 1; return { status: 503, body: { error: { message: 'busy' } }, headers: { 'retry-after': '0' } }; }),
  });
  await assert.rejects(() => c.chat({ prompt: 'x' }), (e) => e.code === 'server' && e.status === 503 && e.retryable);
  assert.equal(calls, 3);
});

test('falls back to plain mode when server rejects response_format', async () => {
  const bodies = [];
  const c = AI.createClient({
    provider: 'openai_compatible', model: 'm',
    fetch: fakeFetch((url, init) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if (b.response_format) return { status: 400, body: { error: { message: 'response_format not supported' } } };
      return { body: { choices: [{ message: { content: '```json\n' + JSON.stringify(sample) + '\n```' } }] } };
    }),
  });
  const { suggestions } = await c.generateSuggestions({});
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(suggestions.summary, 'ok');
});

test('abort signal cancels', async () => {
  const ctrl = new AbortController();
  const c = AI.createClient({ provider: 'demo' });
  const p = c.chat({ prompt: 'x', signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, (e) => e.code === 'aborted');
});

test('ping never throws and lists models', async () => {
  const c = AI.createClient({ provider: 'ollama', fetch: fakeFetch(() => ({ body: { models: [{ name: 'a' }, { name: 'b' }] } })) });
  const r = await c.ping();
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['a', 'b']);
  const bad = AI.createClient({ provider: 'ollama', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  const r2 = await bad.ping();
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Netværksfejl/);
});

test('markdown export', () => {
  const md = AI.suggestionsToMarkdown(AI.normalizeSuggestions(sample), { genre: 'pop', mood: '' });
  assert.match(md, /^# MusikSparring/);
  assert.match(md, /- \*\*genre\*\*: pop/);
  assert.match(md, /`C – G – Am – F`/);
  assert.doesNotMatch(md, /mood/);
});
