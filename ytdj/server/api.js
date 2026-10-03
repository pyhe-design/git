/**
 * JSON API. Two jobs, both genuinely server-side.
 *
 * 1. /api/resolve -- EXTERNAL API CALL to YouTube's public oEmbed endpoint.
 *    Server-side because the browser cannot read that response cross-origin,
 *    and because one cache here serves every client instead of every client
 *    hitting YouTube. Needs no API key and no quota.
 * 2. /api/setlists -- SIDE EFFECT: reads and writes one JSON file on disk, so a
 *    set survives a browser with cleared storage.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseVideoRef, watchUrl } from '../src/core/youtube-url.js';

/** oEmbed answers are immutable in practice; an hour is plenty. */
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;
/** Refuse oversized setlist payloads rather than filling the disk. */
export const MAX_BODY_BYTES = 64 * 1024;
/** Drain at most this multiple of the cap before hanging up on a flood. */
const DRAIN_FACTOR = 8;

/** @type {Map<string, {at: number, value: object}>} */
const cache = new Map();

/** Test seam. */
export function clearResolveCache() {
  cache.clear();
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Look up a video's title, channel and thumbnail.
 *
 * @param {string} input whatever the user pasted.
 * @param {typeof globalThis.fetch} [fetchImpl] injected in tests.
 * @param {number} [now]
 * @returns {Promise<{status: number, body: object}>}
 */
export async function resolveVideo(input, fetchImpl = globalThis.fetch, now = Date.now()) {
  const ref = parseVideoRef(input ?? '');
  if (!ref) {
    return { status: 400, body: { error: 'not_a_youtube_url', message: 'Could not find a YouTube video id in that input.' } };
  }

  const hit = cache.get(ref.id);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return { status: 200, body: { ...hit.value, start: ref.start, cached: true } };
  }

  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(ref.id))}&format=json`;
  /** @type {object} */
  let meta;
  try {
    const response = await fetchImpl(endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return {
        status: 404,
        body: { error: 'unavailable', videoId: ref.id, start: ref.start, message: 'YouTube will not embed that video (private, deleted, or embedding disabled).' },
      };
    }
    if (!response.ok) throw new Error(`oembed responded ${response.status}`);
    const data = /** @type {any} */ (await response.json());
    meta = {
      videoId: ref.id,
      title: typeof data.title === 'string' ? data.title : '',
      author: typeof data.author_name === 'string' ? data.author_name : '',
      thumbnail: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : '',
    };
  } catch (error) {
    // Degrade instead of failing: the client falls back to the player's own
    // getVideoData() once the video is cued.
    return {
      status: 200,
      body: {
        videoId: ref.id,
        start: ref.start,
        title: '',
        author: '',
        thumbnail: '',
        degraded: true,
        message: `Metadata lookup unavailable (${error instanceof Error ? error.message : 'unknown error'}); the player will supply the title.`,
      },
    };
  }

  if (cache.size >= CACHE_MAX) cache.delete(/** @type {string} */ (cache.keys().next().value));
  cache.set(ref.id, { at: now, value: meta });
  return { status: 200, body: { ...meta, start: ref.start, cached: false } };
}

/**
 * Read a request body, refusing anything over MAX_BODY_BYTES.
 *
 * Over the cap it stops buffering but keeps draining the socket, because
 * destroying the request would tear the connection down before the 413 could be
 * written and the client would see a reset instead of an error it can act on.
 * A second, much higher cap stops an endless body from being drained forever.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>} rejects with `payload_too_large` over the cap.
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    let chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (!tooLarge && size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks = [];
      }
      if (tooLarge) {
        // Give up on a flood rather than draining it politely.
        if (size > MAX_BODY_BYTES * DRAIN_FACTOR) {
          req.destroy();
          reject(new Error('payload_too_large'));
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) reject(new Error('payload_too_large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('aborted')));
  });
}

/** One saved set. @typedef {{name: string, savedAt: number, decks: object}} Setlist */

/**
 * Validate and trim a setlist collection. Caps everything so a client cannot
 * grow the file without bound.
 * @param {unknown} raw
 * @returns {Setlist[]}
 */
export function coerceSetlists(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object')
    .slice(0, 50)
    .map((item) => {
      const s = /** @type {Record<string, unknown>} */ (item);
      return {
        name: typeof s.name === 'string' ? s.name.slice(0, 80) : 'Untitled set',
        savedAt: typeof s.savedAt === 'number' && Number.isFinite(s.savedAt) ? s.savedAt : 0,
        decks: s.decks && typeof s.decks === 'object' ? /** @type {object} */ (s.decks) : {},
      };
    });
}

/**
 * SIDE EFFECT: reads `file` from disk. A missing or corrupt file reads as empty.
 * @param {string} file
 * @returns {Promise<Setlist[]>}
 */
export async function readSetlists(file) {
  try {
    return coerceSetlists(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return [];
  }
}

/**
 * SIDE EFFECT: writes `file` on disk, via a temp file and rename so a crash
 * mid-write cannot leave a truncated set behind.
 * @param {string} file
 * @param {unknown} raw
 * @returns {Promise<Setlist[]>} what was stored.
 */
export async function writeSetlists(file, raw) {
  const value = coerceSetlists(raw);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
  return value;
}
