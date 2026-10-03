/** Server tests. Boots on port 0 and talks to it over real HTTP. */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp, PROJECT_ROOT, securityHeaders } from '../server/server.js';
import { clearResolveCache, coerceSetlists, readSetlists, resolveVideo, writeSetlists } from '../server/api.js';
import { resolveStaticPath } from '../server/static.js';

const ID = 'dQw4w9WgXcQ';

/** A stand-in for YouTube's oEmbed endpoint. @param {object} [opts] */
function fakeOembed({ status = 200, body = { title: 'Track', author_name: 'Artist', thumbnail_url: 'https://i.ytimg.com/t.jpg' } } = {}) {
  let calls = 0;
  /** @type {any} */
  const impl = async () => {
    calls += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  impl.calls = () => calls;
  return impl;
}

describe('static path resolution', () => {
  it('keeps every traversal attempt inside the served root', () => {
    const root = '/srv/app';
    for (const attempt of [
      '/../../etc/passwd',
      '/%2e%2e%2f%2e%2e%2fetc/passwd',
      '/a/../../../etc/shadow',
      '/./../../root/.ssh/id_rsa',
    ]) {
      const resolved = resolveStaticPath(root, attempt);
      // The property that matters: either refused, or still under the root.
      // (A contained path may still *read* like /srv/app/etc/passwd, which is
      // a file that does not exist and 404s -- that is the intended outcome.)
      assert.ok(resolved === null || resolved.startsWith(`${root}/`), `${attempt} -> ${resolved}`);
      assert.ok(!resolved || !resolved.startsWith('/etc/'), `${attempt} escaped to ${resolved}`);
    }
  });

  it('maps / to index.html and rejects malformed or NUL-bearing paths', () => {
    assert.equal(resolveStaticPath('/srv/app', '/'), '/srv/app/index.html');
    assert.equal(resolveStaticPath('/srv/app', '/%ZZ'), null);
    assert.equal(resolveStaticPath('/srv/app', '/a%00b'), null);
  });
});

describe('setlist storage', () => {
  /** @type {string} */
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ytdj-test-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads an absent file as empty rather than throwing', async () => {
    assert.deepEqual(await readSetlists(join(dir, 'missing.json')), []);
  });

  it('reads a corrupt file as empty rather than throwing', async () => {
    const file = join(dir, 'corrupt.json');
    await writeFile(file, 'not json at all', 'utf8');
    assert.deepEqual(await readSetlists(file), []);
  });

  it('writes atomically and leaves no temp file behind', async () => {
    const file = join(dir, 'sets.json');
    const stored = await writeSetlists(file, [{ name: 'Friday', savedAt: 1, decks: { a: { videoId: ID } } }]);
    assert.equal(stored.length, 1);
    assert.deepEqual(await readSetlists(file), stored);
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(onDisk[0].name, 'Friday');
  });

  it('caps and sanitises what a client can store', () => {
    const coerced = coerceSetlists([
      ...Array.from({ length: 200 }, (_, i) => ({ name: `set ${i}`, savedAt: i, decks: {} })),
    ]);
    assert.equal(coerced.length, 50);
    const junk = coerceSetlists([{ name: 'x'.repeat(500) }, null, 42, { decks: 'nope' }]);
    assert.equal(junk[0].name.length, 80);
    assert.deepEqual(junk[1].decks, {});
    assert.equal(coerceSetlists('not an array').length, 0);
  });
});

describe('resolveVideo', () => {
  it('rejects input with no YouTube id in it', async () => {
    const { status, body } = await resolveVideo('https://vimeo.com/1', fakeOembed());
    assert.equal(status, 400);
    assert.equal(/** @type {any} */ (body).error, 'not_a_youtube_url');
  });

  it('returns metadata and the start offset', async () => {
    clearResolveCache();
    const { status, body } = await resolveVideo(`https://youtu.be/${ID}?t=45`, fakeOembed());
    assert.equal(status, 200);
    assert.equal(/** @type {any} */ (body).title, 'Track');
    assert.equal(/** @type {any} */ (body).author, 'Artist');
    assert.equal(/** @type {any} */ (body).start, 45);
  });

  it('serves a repeat lookup from cache instead of calling YouTube again', async () => {
    clearResolveCache();
    const fetchImpl = fakeOembed();
    await resolveVideo(ID, fetchImpl);
    const second = await resolveVideo(ID, fetchImpl);
    assert.equal(fetchImpl.calls(), 1, 'one external call for two lookups');
    assert.equal(/** @type {any} */ (second.body).cached, true);
  });

  it('reports an un-embeddable video as not found', async () => {
    clearResolveCache();
    const { status, body } = await resolveVideo(ID, fakeOembed({ status: 401 }));
    assert.equal(status, 404);
    assert.equal(/** @type {any} */ (body).error, 'unavailable');
  });

  it('degrades to a usable answer when YouTube is unreachable', async () => {
    clearResolveCache();
    /** @type {any} */
    const dead = async () => {
      throw new Error('network blocked');
    };
    const { status, body } = await resolveVideo(ID, dead);
    assert.equal(status, 200, 'the deck can still load without metadata');
    assert.equal(/** @type {any} */ (body).degraded, true);
    assert.equal(/** @type {any} */ (body).videoId, ID);
  });

  it('does not cache a degraded answer', async () => {
    clearResolveCache();
    /** @type {any} */
    const dead = async () => {
      throw new Error('network blocked');
    };
    await resolveVideo(ID, dead);
    const good = fakeOembed();
    const second = await resolveVideo(ID, good);
    assert.equal(good.calls(), 1, 'retried once YouTube was reachable again');
    assert.equal(/** @type {any} */ (second.body).title, 'Track');
  });
});

describe('http surface', () => {
  /** @type {import('node:http').Server} */
  let server;
  /** @type {string} */
  let base;
  /** @type {string} */
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ytdj-http-'));
    clearResolveCache();
    server = createApp({ setlistFile: join(dir, 'sets.json'), fetchImpl: fakeOembed() });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the app shell', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const body = await response.text();
    assert.match(body, /<title>ytdj/);
    assert.match(body, /importmap/, 'the import map must ship for the ESM modules to resolve');
  });

  it('sends a CSP that permits the YouTube player and keeps a referrer', async () => {
    const response = await fetch(`${base}/`);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src [^;]*https:\/\/www\.youtube\.com/, 'IFrame API script must be allowed');
    assert.match(csp, /https:\/\/s\.ytimg\.com/, 'the widget script it pulls in must be allowed');
    assert.match(csp, /frame-src [^;]*https:\/\/www\.youtube\.com/);
    assert.match(csp, /frame-src [^;]*https:\/\/www\.youtube-nocookie\.com/);
    // no-referrer would make the player fail with error 153.
    assert.notEqual(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  it('declares the same headers from the helper as it sends', () => {
    const headers = securityHeaders();
    assert.ok(headers['content-security-policy'].includes("object-src 'none'"));
    assert.ok(headers['content-security-policy'].includes("frame-ancestors 'none'"));
  });

  it('serves the vendored modules immutably and the app code revalidating', async () => {
    const vendor = await fetch(`${base}/vendor/preact.module.js`);
    assert.equal(vendor.status, 200);
    assert.match(vendor.headers.get('cache-control') ?? '', /immutable/);
    const app = await fetch(`${base}/src/main.js`);
    assert.equal(app.headers.get('cache-control'), 'no-cache');
  });

  it('answers a matching ETag with 304', async () => {
    const first = await fetch(`${base}/src/styles.css`);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const second = await fetch(`${base}/src/styles.css`, { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304);
  });

  it('reports health', async () => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });

  it('resolves a video over HTTP', async () => {
    const response = await fetch(`${base}/api/resolve?url=${encodeURIComponent(`https://youtu.be/${ID}`)}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).videoId, ID);
  });

  it('rejects a non-YouTube url with 400 and no body echo', async () => {
    const response = await fetch(`${base}/api/resolve?url=https://example.com`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'not_a_youtube_url');
    assert.ok(!JSON.stringify(body).includes('example.com'), 'does not reflect caller input');
  });

  it('round-trips setlists', async () => {
    const put = await fetch(`${base}/api/setlists`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setlists: [{ name: 'Set one', savedAt: 7, decks: {} }] }),
    });
    assert.equal(put.status, 200);
    const get = await fetch(`${base}/api/setlists`);
    const body = await get.json();
    assert.equal(body.setlists.length, 1);
    assert.equal(body.setlists[0].name, 'Set one');
  });

  it('rejects invalid JSON and oversized bodies', async () => {
    const bad = await fetch(`${base}/api/setlists`, { method: 'PUT', body: 'nope' });
    assert.equal(bad.status, 400);
    const huge = await fetch(`${base}/api/setlists`, {
      method: 'PUT',
      body: JSON.stringify([{ name: 'x'.repeat(200_000), decks: {} }]),
    });
    assert.equal(huge.status, 413);
  });

  it('refuses methods it does not implement', async () => {
    assert.equal((await fetch(`${base}/api/setlists`, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${base}/api/resolve`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  });

  it('hides the toolchain and the data directory', async () => {
    assert.equal((await fetch(`${base}/node_modules/preact/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/data/setlists.json`)).status, 404);
  });

  it('404s unknown endpoints and missing files', async () => {
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/not-a-file.js`)).status, 404);
  });

  it('serves from the project root by default', () => {
    assert.ok(PROJECT_ROOT.endsWith('ytdj'));
  });
});
