#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots the real server, then routes https://www.youtube.com/iframe_api to a
 * local stub so no network and no real playback are needed. Drives the console
 * the way a user would and asserts the behaviour that unit tests cannot reach:
 * that the crossfader actually lands the right integers on the players, that
 * volume writes are coalesced rather than spammed, and that sync issues seeks.
 *
 * Fails on any console error, page error or failed request.
 *
 * Run: npm run test:smoke   (SMOKE_SHOTS=/dir to also save screenshots)
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApp } from '../server/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const A = 'dQw4w9WgXcQ';
const B = 'kJQP7kiw5Fk';

/** Stand in for YouTube's oEmbed endpoint so the server makes no outbound call. */
const fakeFetch = async (/** @type {string} */ url) => {
  const id = /v%3D([A-Za-z0-9_-]{11})/.exec(String(url))?.[1] ?? 'unknown';
  return {
    ok: true,
    status: 200,
    json: async () => ({
      title: `Stub ${id}`,
      author_name: 'Stub channel',
      thumbnail_url: 'https://i.ytimg.com/vi/x/default.jpg',
    }),
  };
};

const failures = [];
/** @param {string} kind @param {string} message */
const fail = (kind, message) => failures.push(`[${kind}] ${message}`);

const checks = [];
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` -- ${detail}` : ''}\n`);
  if (!ok) fail('assert', `${name}${detail ? `: ${detail}` : ''}`);
}

const server = createApp({ fetchImpl: /** @type {any} */ (fakeFetch) });
await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

/**
 * Honour a Chromium that the container already has. A CI image often ships a
 * build that does not match the playwright package's expected revision, and
 * downloading another one is both slow and usually blocked.
 * @returns {string|undefined}
 */
function findChromium() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!dir) return undefined;
  const candidates = globSync(dir);
  return candidates[0];
}

/** @param {string} dir @returns {string[]} */
function globSync(dir) {
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries.sort().reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const candidate = join(dir, entry, rel);
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

const executablePath = findChromium();
if (executablePath) process.stdout.write(`using chromium at ${executablePath}\n`);
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const shots = process.env.SMOKE_SHOTS || '';
/** @param {string} name */
const shot = async (name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};

page.on('console', (msg) => {
  if (msg.type() === 'error') fail('console', msg.text());
});
page.on('pageerror', (error) => fail('pageerror', error.message));
page.on('requestfailed', (request) => {
  // The stub replaces the API script; nothing else may fail.
  fail('requestfailed', `${request.url()} ${request.failure()?.errorText ?? ''}`);
});

// Serve the stub in place of the real IFrame API.
const stub = await readFile(join(here, 'fixtures', 'yt-stub.js'), 'utf8');
await page.route('https://www.youtube.com/iframe_api', (route) =>
  route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: stub }),
);

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#crossfader', { timeout: 10_000 });
  check('console mounts', true);
  await shot('01-empty');

  // ---------------------------------------------------------------- loading
  for (const [side, id] of [['a', A], ['b', B]]) {
    await page.fill(`#url-${side}`, `https://www.youtube.com/watch?v=${id}`);
    await page.click(`#deck-${side} button.primary`);
    await page.waitForFunction(
      (vid) => (window.__ytStub?.players ?? []).some((p) => p.videoId === vid && !p.destroyed),
      id,
      { timeout: 10_000 },
    );
  }
  const players = await page.evaluate(() => window.__ytStub.players.map((p) => p.videoId));
  check('both decks created a player', players.length === 2, players.join(', '));

  const frames = await page.$$eval('.stage iframe', (nodes) =>
    nodes.map((n) => {
      const box = n.getBoundingClientRect();
      const style = getComputedStyle(n);
      return { w: Math.round(box.width), h: Math.round(box.height), display: style.display, visibility: style.visibility };
    }),
  );
  check('two players are on screen', frames.length === 2, JSON.stringify(frames));
  check(
    'players stay visible and at least 200x200, as YouTube requires',
    frames.every((f) => f.w >= 200 && f.h >= 200 && f.display !== 'none' && f.visibility !== 'hidden'),
    JSON.stringify(frames),
  );

  const titles = await page.$$eval('.deck-title', (nodes) => nodes.map((n) => n.textContent?.trim() ?? ''));
  check(
    'deck titles come from the metadata lookup',
    titles[0]?.includes(A) === true && titles[1]?.includes(B) === true,
    titles.join(' | '),
  );
  await shot('02-loaded');

  // ------------------------------------------------------------- crossfader
  /** @param {number} value */
  const setFader = async (value) => {
    await page.$eval(
      '#crossfader',
      (el, v) => {
        const input = /** @type {HTMLInputElement} */ (el);
        input.value = String(v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      value,
    );
    // Let the rAF-coalesced volume flush run.
    await page.waitForTimeout(120);
  };

  const volumes = async () =>
    page.evaluate(() => {
      const [a, b] = window.__ytStub.players;
      return { a: a.volume, b: b.volume };
    });

  await setFader(0);
  let v = await volumes();
  check('fader hard left opens A and closes B', v.a > 0 && v.b === 0, JSON.stringify(v));

  await setFader(1);
  v = await volumes();
  check('fader hard right opens B and closes A', v.b > 0 && v.a === 0, JSON.stringify(v));

  await setFader(0.5);
  v = await volumes();
  const master = await page.$eval('#master', (el) => Number(/** @type {HTMLInputElement} */ (el).value));
  const expected = Math.round(Math.cos(Math.PI / 4) * master * 100);
  check(
    'equal-power centre puts both decks at -3 dB',
    v.a === expected && v.b === expected,
    `got ${JSON.stringify(v)}, expected ${expected} (master ${master})`,
  );

  // ------------------------------------------------- write coalescing budget
  await page.evaluate(() => {
    window.__ytStub.volumeWrites.length = 0;
  });
  for (let i = 0; i <= 50; i += 1) {
    await page.$eval(
      '#crossfader',
      (el, v2) => {
        const input = /** @type {HTMLInputElement} */ (el);
        input.value = String(v2);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      i / 50,
    );
  }
  await page.waitForTimeout(200);
  const writes = await page.evaluate(() => window.__ytStub.volumeWrites.length);
  check(
    'a fader sweep is coalesced, not one call per input event',
    writes > 0 && writes < 102,
    `${writes} volume writes for 51 input events across 2 decks`,
  );

  // -------------------------------------------------------------- transport
  await page.click('#deck-a button:has-text("Play")');
  await page.waitForFunction(() => window.__ytStub.players[0].getPlayerState() === 1, undefined, { timeout: 5000 });
  check('deck A plays', true);
  await page.click('#deck-b button:has-text("Play")');
  await page.waitForFunction(() => window.__ytStub.players[1].getPlayerState() === 1, undefined, { timeout: 5000 });
  check('deck B plays', true);

  await page.click('#deck-a button:has-text("Pause")');
  await page.waitForFunction(() => window.__ytStub.players[0].getPlayerState() === 2, undefined, { timeout: 5000 });
  check('deck A pauses', true);
  await page.click('#deck-a button:has-text("Play")');

  // Kill switch must zero the volume outright.
  await setFader(0.5);
  await page.click('#deck-a button:has-text("Kill")');
  await page.waitForTimeout(120);
  v = await volumes();
  check('kill switch zeroes deck A', v.a === 0 && v.b > 0, JSON.stringify(v));
  await page.click('#deck-a button:has-text("Kill")');
  await page.waitForTimeout(120);

  // ------------------------------------------------------------------- sync
  await page.evaluate(() => {
    window.__ytStub.seeks.length = 0;
    // Shove deck B well off deck A so the captured offset is unmistakable.
    window.__ytStub.players[1].seekTo(80, true);
  });
  await page.click('button:has-text("Sync off")');
  await page.waitForSelector('button:has-text("Sync on")', { timeout: 5000 });
  check('sync engages', true);
  // Engaging must capture the offset from live clocks, not from the last poll,
  // so a seek immediately beforehand is still reflected.
  const captured = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.readout dt')].find((d) => d.textContent === 'Offset');
    return row?.nextElementSibling?.textContent ?? '';
  });
  check(
    'the captured offset reflects a seek made just before engaging',
    /\+7\d\.\d\d s/.test(captured),
    `offset reads ${captured}`,
  );

  const offsetText = await page.textContent('.readout');
  check('sync captured a non-zero offset', /[+−]\d+\.\d\d s/.test(offsetText ?? ''), offsetText?.slice(0, 120) ?? '');

  // Drag deck B off its lock, then count seeks from a baseline taken in the
  // same evaluate. Clearing the log *after* the nudge would be a race: the
  // corrector ticks at 15 Hz and can fire between the two statements, and
  // wiping that correction leaves it in cooldown with nothing left to correct.
  const stillLocked = await page.$('button:has-text("Sync on")');
  check('sync is still engaged before the drift test', Boolean(stillLocked));

  const seekBaseline = await page.evaluate(() => {
    const b = window.__ytStub.players[1];
    b.seekTo(b.getCurrentTime() + 3, true);
    return window.__ytStub.seeks.length;
  });
  await page.waitForFunction((n) => window.__ytStub.seeks.length > n, seekBaseline, { timeout: 8000 });
  const corrections = await page.evaluate((n) => window.__ytStub.seeks.length - n, seekBaseline);
  check('the drift corrector seeks the follower back onto its lock', corrections > 0, `${corrections} seeks`);

  // The deadband must stop it from seeking continuously.
  await page.waitForTimeout(2500);
  const after = await page.evaluate((n) => window.__ytStub.seeks.length - n, seekBaseline);
  check('the deadband stops the corrector thrashing', after <= 4, `${after} corrective seeks over ~2.5 s`);

  await page.click('button:has-text("Sync on")');
  await page.waitForSelector('button:has-text("Sync off")', { timeout: 5000 });
  check('sync releases', true);

  // ------------------------------------------------------------- tap tempo
  // Record when the taps actually land: Playwright's click latency makes the
  // nominal cadence unreliable, and the point of this check is the app's
  // median-interval maths, not the harness's timing.
  /** @type {number[]} */
  const tapAt = [];
  for (let i = 0; i < 6; i += 1) {
    await page.click('#deck-a button:has-text("Tap")');
    tapAt.push(Date.now());
    if (i < 5) await page.waitForTimeout(480);
  }
  const gaps = tapAt.slice(1).map((t, i) => t - tapAt[i]).sort((x, y) => x - y);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  const expectedBpm = 60_000 / medianGap;
  const bpm = await page.$eval('#bpm-a', (el) => Number(/** @type {HTMLInputElement} */ (el).value));
  check(
    'tap tempo matches the median interval actually tapped',
    Math.abs(bpm - expectedBpm) < 4,
    `app says ${bpm} BPM, taps imply ${expectedBpm.toFixed(1)} BPM (median gap ${medianGap} ms)`,
  );

  // ------------------------------------------------------------ auto-fade
  await setFader(0);
  await page.$eval('#fade-seconds', (el) => {
    const input = /** @type {HTMLInputElement} */ (el);
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('button:has-text("To B ▶")');
  await page.waitForFunction(
    () => Number(document.querySelector('#crossfader').value) > 0.9,
    undefined,
    { timeout: 6000 },
  );
  check('auto-fade rides the crossfader to deck B', true);

  // ------------------------------------------------------------- shortcuts
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  const moved = await page.$eval('#crossfader', (el) => Number(/** @type {HTMLInputElement} */ (el).value));
  check('arrow keys move the crossfader', moved < 0.99, `position ${moved}`);

  await page.click('#url-a');
  await page.keyboard.type('q');
  const stillTyping = await page.$eval('#url-a', (el) => /** @type {HTMLInputElement} */ (el).value);
  check('shortcuts stay out of the way while typing', stillTyping.includes('q'), stillTyping);

  // -------------------------------------------------- reload and embed host
  const C = '9bZkp7q19f0';
  await page.fill('#url-a', `https://youtu.be/${C}`);
  await page.click('#deck-a button.primary');
  await page.waitForFunction((vid) => window.__ytStub.players[0].videoId === vid, C, { timeout: 8000 });
  const reusedPlayer = await page.evaluate(() => window.__ytStub.players.length);
  check(
    'loading a new video reuses the existing player instead of building another',
    reusedPlayer === 2,
    `${reusedPlayer} players created in total`,
  );

  const hostsBefore = await page.evaluate(() => window.__ytStub.players.map((p) => p.opts.host));
  check(
    'privacy mode routes embeds through youtube-nocookie.com',
    hostsBefore.every((h) => h === 'https://www.youtube-nocookie.com'),
    hostsBefore.join(', '),
  );

  await page.click('button:has-text("No-cookie embeds")');
  await page.waitForSelector('button:has-text("Standard embeds")', { timeout: 5000 });
  await page.fill('#url-a', `https://youtu.be/${A}`);
  await page.click('#deck-a button.primary');
  await page.waitForFunction(
    () => window.__ytStub.players.some((p) => !p.destroyed && p.opts.host === 'https://www.youtube.com'),
    undefined,
    { timeout: 8000 },
  );
  const rebuilt = await page.evaluate(() =>
    window.__ytStub.players.filter((p) => !p.destroyed).map((p) => p.opts.host),
  );
  check(
    'switching the embed host rebuilds the player on the next load',
    rebuilt.includes('https://www.youtube.com'),
    rebuilt.join(', '),
  );
  const liveFrames = await page.$$eval('.stage iframe', (nodes) => nodes.length);
  check('the rebuild leaves exactly one iframe per deck', liveFrames === 2, `${liveFrames} iframes on the page`);
  await page.click('button:has-text("Standard embeds")');

  // ---------------------------------------------------------------- themes
  for (const theme of ['noir', 'amber', 'daylight', 'midnight']) {
    await page.selectOption('#theme', theme);
    let applied = null;
    try {
      // data-theme is written in an effect, so it lands a frame later.
      await page.waitForFunction(
        (t) => document.documentElement.dataset.theme === t,
        theme,
        { timeout: 2000 },
      );
      applied = theme;
    } catch {
      applied = await page.getAttribute('html', 'data-theme');
    }
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(`theme ${theme} applies`, applied === theme, `data-theme=${applied}, body bg ${background}`);
  }
  await page.selectOption('#theme', 'daylight');
  await shot('03-daylight');
  await page.selectOption('#theme', 'midnight');

  // ------------------------------------------------------------ persistence
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#crossfader', { timeout: 10_000 });
  const restored = await page.evaluate(() => {
    const raw = localStorage.getItem('ytdj.session.v1');
    return raw ? JSON.parse(raw) : null;
  });
  check('the session persists across a reload', restored?.decks?.a?.videoId === A, JSON.stringify(restored?.decks?.a ?? null));

  // ------------------------------------------------------------ responsive
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal scroll at phone width', overflow <= 1, `${overflow}px of overflow`);
  const tap = await page.$$eval('.deck button', (nodes) =>
    nodes.map((n) => Math.round(n.getBoundingClientRect().height)),
  );
  check('touch targets are at least 44px on a phone', tap.every((h) => h >= 44), JSON.stringify(tap.slice(0, 6)));
  await shot('04-phone');

  await page.setViewportSize({ width: 1440, height: 1000 });

  // ----------------------------------------------------------- accessibility
  const a11y = await page.evaluate(() => {
    const unlabelled = [];
    for (const el of document.querySelectorAll('input, select, button, canvas')) {
      const id = el.getAttribute('id');
      const labelled =
        el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby') ||
        (id && document.querySelector(`label[for="${id}"]`)) ||
        el.closest('label') ||
        (el.tagName === 'BUTTON' && (el.textContent ?? '').trim().length > 0);
      if (!labelled) unlabelled.push(`${el.tagName}#${id || '(no id)'}`);
    }
    return {
      unlabelled,
      faderText: document.querySelector('#crossfader')?.getAttribute('aria-valuetext') ?? null,
      liveRegion: document.querySelector('#live-region')?.getAttribute('aria-live') ?? null,
      landmarks: document.querySelectorAll('header, section, footer').length,
      h1: document.querySelectorAll('h1').length,
    };
  });
  check('every control carries an accessible name', a11y.unlabelled.length === 0, a11y.unlabelled.join(', '));
  check('the crossfader speaks its position', Boolean(a11y.faderText), String(a11y.faderText));
  check('a polite live region exists for announcements', a11y.liveRegion === 'polite', String(a11y.liveRegion));
  check('exactly one h1', a11y.h1 === 1, String(a11y.h1));
} catch (error) {
  fail('exception', error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  await browser.close();
  await new Promise((r) => server.close(() => r(undefined)));
}

const passed = checks.filter((c) => c.ok).length;
process.stdout.write(`\n${passed}/${checks.length} checks passed\n`);

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} problem(s):\n${failures.map((f) => `  ${f}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('smoke test passed\n');
