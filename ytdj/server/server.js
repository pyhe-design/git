/**
 * The HTTP server. Node core only -- no Express, no middleware stack.
 *
 * Routes:
 *   GET  /api/health
 *   GET  /api/resolve?url=...   video metadata (proxied oEmbed, cached)
 *   GET  /api/setlists          saved sets
 *   PUT  /api/setlists          replace saved sets
 *   *                           static files from the project root
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBody, readSetlists, resolveVideo, sendJson, writeSetlists } from './api.js';
import { serveStatic } from './static.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolvePath(HERE, '..');

/**
 * CSP source expressions for the inline scripts a page legitimately needs.
 *
 * The import map has to be inline -- browsers do not load external import maps
 * -- so it is allowed by hash rather than by opening the policy to
 * 'unsafe-inline'. The hash is derived from the shipped HTML at boot, so it
 * cannot drift away from what is actually served.
 *
 * @param {string} html
 * @returns {string[]} e.g. ["'sha256-...'"]
 */
export function inlineScriptHashes(html) {
  /** @type {string[]} */
  const hashes = [];
  const re = /<script\b[^>]*\btype=(?:"|')(?:importmap|application\/json)(?:"|')[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const digest = createHash('sha256').update(match[1], 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

/**
 * Security headers.
 *
 * Three entries are load-bearing and must not be tightened without breaking
 * playback:
 *  - `script-src` must allow www.youtube.com (the IFrame API) and s.ytimg.com
 *    (the widget script it pulls in next).
 *  - `script-src` must also carry the import map's hash, or the ES modules
 *    cannot resolve their bare "preact" specifier.
 *  - `referrer-policy` must still send an origin. With `no-referrer` the player
 *    fails with error 153, "missing HTTP Referer".
 *
 * @param {string[]} [scriptHashes]
 * @returns {Record<string, string>}
 */
export function securityHeaders(scriptHashes = []) {
  const csp = [
    "default-src 'self'",
    ["script-src 'self' https://www.youtube.com https://s.ytimg.com", ...scriptHashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://i.ytimg.com https://i9.ytimg.com",
    "font-src 'self'",
    "connect-src 'self'",
    'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
  return {
    'content-security-policy': csp,
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy':
      'autoplay=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"), camera=(), microphone=(), geolocation=()',
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.root] directory to serve static files from.
 * @param {string} [options.setlistFile]
 * @param {typeof globalThis.fetch} [options.fetchImpl] injected in tests.
 * @returns {import('node:http').Server}
 */
export function createApp({
  root = PROJECT_ROOT,
  setlistFile = join(PROJECT_ROOT, 'data', 'setlists.json'),
  fetchImpl = globalThis.fetch,
} = {}) {
  // Read the shell once at boot so the import map's hash is always in step
  // with the file actually being served.
  /** @type {string[]} */
  let scriptHashes = [];
  try {
    scriptHashes = inlineScriptHashes(readFileSync(join(root, 'index.html'), 'utf8'));
  } catch {
    scriptHashes = [];
  }
  const headers = securityHeaders(scriptHashes);

  return createServer(async (req, res) => {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;
    const method = req.method ?? 'GET';

    try {
      if (pathname === '/api/health') {
        sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
        return;
      }

      if (pathname === '/api/resolve') {
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }
        const { status, body } = await resolveVideo(url.searchParams.get('url') ?? '', fetchImpl);
        sendJson(res, status, body);
        return;
      }

      if (pathname === '/api/setlists') {
        if (method === 'GET') {
          sendJson(res, 200, { setlists: await readSetlists(setlistFile) });
          return;
        }
        if (method === 'PUT') {
          let parsed;
          try {
            parsed = JSON.parse(await readBody(req));
          } catch (error) {
            const tooLarge = error instanceof Error && error.message === 'payload_too_large';
            // The body was not fully read, so this connection cannot be reused.
            res.setHeader('connection', 'close');
            sendJson(res, tooLarge ? 413 : 400, {
              error: tooLarge ? 'payload_too_large' : 'invalid_json',
            });
            return;
          }
          const stored = await writeSetlists(
            setlistFile,
            Array.isArray(parsed) ? parsed : /** @type {any} */ (parsed)?.setlists,
          );
          sendJson(res, 200, { setlists: stored });
          return;
        }
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'unknown_endpoint' });
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }

      // node_modules exists only for the toolchain; never expose it.
      if (pathname.startsWith('/node_modules') || pathname.startsWith('/data/')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found\n');
        return;
      }

      if (await serveStatic(req, res, root, pathname)) return;

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
    } catch (error) {
      process.stderr.write(`[ytdj] ${method} ${pathname} failed: ${String(error)}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.destroy();
    }
  });
}
