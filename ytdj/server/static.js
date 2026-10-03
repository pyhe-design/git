/**
 * Static file serving for the app shell. No dependencies.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const MIME = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
});

/**
 * Resolve a request path to a file inside `root`, or null if it escapes.
 *
 * The guard is the `startsWith(root + sep)` check: decoding first and
 * normalising second means `%2e%2e%2f` and `../` are both caught.
 *
 * @param {string} root absolute directory.
 * @param {string} pathname URL pathname, still percent-encoded.
 * @returns {string|null}
 */
export function resolveStaticPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = normalize(decoded === '/' ? '/index.html' : decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const target = resolve(join(root, relative));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

/**
 * @param {import('node:fs').Stats} stats
 * @returns {string} weak validator built from size and mtime.
 */
function etagFor(stats) {
  return `W/"${createHash('sha1').update(`${stats.size}-${stats.mtimeMs}`).digest('base64url')}"`;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} root
 * @param {string} pathname
 * @returns {Promise<boolean>} false when nothing was served.
 */
export async function serveStatic(req, res, root, pathname) {
  const file = resolveStaticPath(root, pathname);
  if (!file) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden\n');
    return true;
  }

  let stats;
  try {
    stats = await stat(file);
    if (stats.isDirectory()) {
      stats = await stat(join(file, 'index.html'));
      return serveStatic(req, res, root, `${pathname.replace(/\/$/, '')}/index.html`);
    }
  } catch {
    return false;
  }

  const etag = etagFor(stats);
  const immutable = pathname.startsWith('/vendor/');
  const headers = {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(stats.size),
    etag,
    'last-modified': stats.mtime.toUTCString(),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': headers['cache-control'] });
    res.end();
    return true;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return true;
  }

  res.writeHead(200, headers);
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}
