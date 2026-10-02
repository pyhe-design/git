#!/usr/bin/env node
/* Minimal CLI: generate suggestions from the terminal with a local model.
 *
 *   node sdk/examples/node-cli.mjs --genre "lo-fi" --key Am --bpm 84
 *   MS_PROVIDER=ollama MS_MODEL=qwen2.5:7b node sdk/examples/node-cli.mjs --genre house
 *   MS_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... node sdk/examples/node-cli.mjs --genre pop --json
 *
 * Env: MS_PROVIDER (demo|ollama|lmstudio|openai_compatible|anthropic|openai), MS_MODEL, MS_BASE_URL,
 *      ANTHROPIC_API_KEY / OPENAI_API_KEY / MS_API_KEY.
 * EXTERNAL CALL: performs one HTTP request to the chosen provider (none for demo).
 */
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const AI = require('../musiksparring-ai.js');

const { values } = parseArgs({
  options: {
    genre: { type: 'string' }, mood: { type: 'string' }, bpm: { type: 'string' }, key: { type: 'string' },
    references: { type: 'string' }, existing: { type: 'string' }, constraints: { type: 'string' }, goals: { type: 'string' },
    json: { type: 'boolean', default: false }, list: { type: 'boolean', default: false },
  },
});

const provider = process.env.MS_PROVIDER || 'demo';
const client = AI.createClient({
  provider,
  model: process.env.MS_MODEL,
  baseUrl: process.env.MS_BASE_URL,
  apiKey: process.env.MS_API_KEY || (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY),
});

if (values.list) {
  const r = await client.ping();
  if (!r.ok) { console.error(`✗ ${client.meta.label}: ${r.error}`); process.exit(1); }
  console.log(`✓ ${client.meta.label} (${r.latencyMs} ms)\n` + r.models.map((m) => `  ${m}`).join('\n'));
  process.exit(0);
}

const params = Object.fromEntries(Object.entries(values).filter(([k, v]) => k !== 'json' && k !== 'list' && v));
const json = values.json;
try {
  const { suggestions, meta } = await client.generateSuggestions(params);
  if (json) {
    console.log(JSON.stringify({ params, suggestions, meta }, null, 2));
  } else {
    console.log(AI.suggestionsToMarkdown(suggestions, params));
    console.error(`— ${client.meta.label}${meta.model ? ' · ' + meta.model : ''} · ${(meta.durationMs / 1000).toFixed(1)} s`);
  }
} catch (e) {
  console.error(`✗ ${e.code || 'error'}: ${e.message}`);
  process.exit(1);
}
