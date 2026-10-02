#!/usr/bin/env node
/* Headless smoke test: serves the project, drives every view, and fails on any console
 * error / page error / failed request. Run: npm test */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = join(root, p);
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('dir');
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const problems = [];
const note = (kind, msg) => problems.push(`[${kind}] ${msg}`);

// Honour a pre-installed browser (CI containers): PW_CHROMIUM=/path/to/chrome
// Honour a pre-installed browser (CI containers): PW_CHROMIUM=/path/to/chrome
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const shots = process.env.SMOKE_SHOTS || '';
let page = null;
const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };

/** Fresh context per run → isolated localStorage. */
async function openPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx.newPage();
  // Keep the run hermetic: no external font fetches.
  await page.route(/^https:\/\/fonts\./, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') note('console.' + m.type(), m.text()); });
  page.on('pageerror', (e) => note('pageerror', e.message));
  page.on('requestfailed', (r) => note('requestfailed', `${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) note('http', `${r.status()} ${r.url()}`); });
  return ctx;
}

async function run(target) {
  const ctx = await openPage();
  await page.goto(target, { waitUntil: 'load' });
  await page.waitForSelector('.topbar');
  await shot('input');

  // Input view: fill form, generate in demo mode.
  await page.fill('#f-genre', 'Indie pop');
  await page.fill('#f-mood', 'Melankolsk');
  await page.fill('#f-bpm', '104');
  await page.fill('#f-key', 'Am');
  await page.click('button:has-text("Generér forslag")');
  await page.waitForSelector('.summary', { timeout: 10000 });
  await shot('results');
  const progCount = await page.locator('.prog').count();
  if (progCount < 3) note('assert', `expected ≥3 progressions, got ${progCount}`);

  // Chord lab from results.
  await page.locator('.prog .chord-pill').first().click();
  await page.waitForSelector('.fretboard');
  await page.click('button:has-text("Afspil progression")');
  await page.waitForTimeout(300);
  await page.click('button:has-text("Stop")');
  await page.click('button:has-text("Kopiér som Markdown")');

  // Tools view.
  await page.click('.nav-btn:has-text("Værktøjer")');
  await page.waitForSelector('.piano');
  await page.selectOption('select >> nth=1', 'Dorisk');
  await page.click('button:has-text("Vis intervaller")');
  await page.click('button:has-text("Afspil skala")');
  await page.locator('.key.white').first().click();
  await page.locator('.key.black').first().click();
  await page.fill('input[aria-label="Akkordsymbol"]', 'F#m7');
  await page.click('button:has-text("Afspil akkord")');
  await page.fill('input[aria-label="Akkordsymbol"]', 'Bbmaj7');
  await page.fill('input[aria-label="Akkordsymbol"]', 'Xyz');
  await page.fill('input[aria-label="Akkordsymbol"]', 'G/B');
  await page.click('.seq-cells .cell >> nth=3');
  await page.click('.card:has(.seq) button[aria-pressed="false"]');
  await page.waitForTimeout(700);
  const headSeen = await page.locator('.cell.is-head').count();
  if (headSeen === 0) note('assert', 'sequencer playhead never rendered');
  await shot('tools');
  await page.click('.card:has(.seq) button[aria-pressed="true"]');
  await page.click('button:has-text("Tap")');
  await page.click('button:has-text("Tap")');
  await page.click('button:has-text("Tilfældig")');
  await page.selectOption('.select >> nth=2', 'Trap');

  // Settings drawer + provider adapters against mocked endpoints.
  const mock = (params) => JSON.stringify({
    summary: 'Mocked summary', questions: ['Q1'], directions: ['D1'],
    chords: [{ label: 'I–V–vi–IV', chords: ['C', 'G', 'Am', 'F'], note: 'n' }],
    melodies: ['M1'], rhythm: ['R1'], arrangement: ['A1'], production: ['P1'], lyrics: ['L1'], actions: ['Next ' + params],
  });
  const seen = { ollamaTags: 0, ollamaChat: null, anthropic: null, anthropicHeaders: null };
  await page.route('http://localhost:11434/**', (route) => {
    const u = route.request().url();
    if (u.endsWith('/api/tags')) { seen.ollamaTags++; return route.fulfill({ json: { models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1' }] } }); }
    if (u.endsWith('/api/chat')) {
      seen.ollamaChat = route.request().postDataJSON();
      return route.fulfill({ json: { model: seen.ollamaChat.model, message: { role: 'assistant', content: '```json\n' + mock('ollama') + '\n```' }, prompt_eval_count: 321, eval_count: 123 } });
    }
    return route.fulfill({ status: 404, body: 'nope' });
  });
  await page.route('https://api.anthropic.com/**', (route) => {
    seen.anthropic = route.request().postDataJSON();
    seen.anthropicHeaders = route.request().headers();
    return route.fulfill({ json: { model: seen.anthropic.model, stop_reason: 'end_turn', content: [{ type: 'text', text: mock('claude') }], usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 400 } } });
  });

  await page.click('.provider-pill');
  await page.waitForSelector('.drawer');
  await page.click('.provider-opt:has-text("Ollama")');
  await shot('settings');
  await page.click('button:has-text("Test forbindelse")');
  await page.waitForSelector('.status-line.ok');
  await page.fill('.drawer input[list="ms-models"]', 'qwen2.5:7b');
  await page.click('button:has-text("Færdig")');
  await page.click('.nav-btn:has-text("Input")');
  await page.click('button:has-text("Generér forslag")');
  await page.waitForFunction(() => /Mocked summary/.test(document.querySelector('.summary')?.textContent || ''), null, { timeout: 10000 });
  if (seen.ollamaTags < 1) note('assert', 'ollama /api/tags never called');
  if (!seen.ollamaChat || seen.ollamaChat.model !== 'qwen2.5:7b' || typeof seen.ollamaChat.format !== 'object' || seen.ollamaChat.stream !== false) note('assert', `bad ollama request: ${JSON.stringify(seen.ollamaChat).slice(0, 200)}`);
  const pills = await page.locator('.prog .chord-pill').allInnerTexts();
  if (pills.join(' ') !== 'C G Am F') note('assert', `bare chords lost: ${pills.join(' ')}`);
  if (!(await page.locator('.meta-line').innerText()).includes('321 → 123')) note('assert', 'ollama usage not shown');

  // Anthropic: key validation, then a mocked round-trip.
  await page.click('.provider-pill');
  await page.click('.provider-opt:has-text("Anthropic")');
  await page.fill('.drawer input[type="password"]', 'wrong');
  await page.click('button:has-text("Færdig")');
  await page.click('.nav-btn:has-text("Input")');
  await page.click('button:has-text("Generér forslag")');
  await page.waitForFunction(() => /sk-ant-/.test(document.querySelector('.alert.err')?.textContent || ''));
  await page.waitForSelector('.drawer');
  await page.fill('.drawer input[type="password"]', 'sk-ant-test-123');
  await page.click('button:has-text("Færdig")');
  await page.click('button:has-text("Generér forslag")');
  await page.waitForFunction(() => /Next claude/.test(document.body.textContent || ''), null, { timeout: 10000 });
  const a = seen.anthropic;
  const ah = seen.anthropicHeaders || {};
  if (!a || a.model !== 'claude-opus-5-5' || a.output_config?.format?.type !== 'json_schema' || a.system?.[0]?.cache_control?.type !== 'ephemeral' || a.thinking !== undefined) note('assert', `bad anthropic body: ${JSON.stringify(a).slice(0, 300)}`);
  if (ah['x-api-key'] !== 'sk-ant-test-123' || ah['anthropic-version'] !== '2023-06-01' || ah['anthropic-dangerous-direct-browser-access'] !== 'true') note('assert', `bad anthropic headers: ${JSON.stringify(ah)}`);
  if (!(await page.locator('.meta-line').innerText()).includes('cache: 400')) note('assert', 'cache usage not shown');
  await page.click('.provider-pill');
  await page.click('.provider-opt:has-text("Demo")');
  await page.keyboard.press('Escape');
  await page.unroute('http://localhost:11434/**');
  await page.unroute('https://api.anthropic.com/**');

  // History + keyboard shortcuts.
  await page.keyboard.press('4');
  await page.waitForSelector('.hist-item');
  await page.click('.hist-item button:has-text("Åbn")');
  await page.waitForSelector('.summary');
  await page.keyboard.press('1');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.summary', { timeout: 10000 });

  // Mobile viewport sanity.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(200);
  await shot('mobile');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (overflow) note('assert', 'horizontal page overflow at 390px');
  await page.setViewportSize({ width: 1280, height: 900 });
  await ctx.close();
}

try {
  await run(`${base}/index.html`);
  await run(`${base}/dist/musiksparring_v3.html`);
} catch (e) {
  note('exception', e.stack || String(e));
}
await browser.close();
server.close();

if (problems.length) {
  console.error(`FAIL (${problems.length})\n` + problems.join('\n'));
  process.exit(1);
}
console.log('OK: no console errors, page errors, failed requests or assertion failures (index.html + dist).');
