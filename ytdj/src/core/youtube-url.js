/**
 * YouTube URL / video-id parsing. Pure: no DOM, no network.
 * Accepts the shapes a DJ will actually paste, rejects everything else.
 */

/** Video ids are exactly 11 chars of the URL-safe base64 alphabet. */
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
]);

/** `/embed/ID`, `/v/ID`, `/shorts/ID`, `/live/ID` */
const PATH_RE = /^\/(?:embed|v|shorts|live)\/([A-Za-z0-9_-]{11})/;

/**
 * @param {unknown} value
 * @returns {boolean} true when `value` is a syntactically valid video id.
 */
export function isVideoId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

/**
 * Parse a `t` / `start` timestamp: `90`, `90s`, `1m30s`, `1h2m3s`.
 * @param {string|null} raw
 * @returns {number} whole seconds, 0 when absent or unparseable.
 */
export function parseTimestamp(raw) {
  if (!raw) return 0;
  const plain = raw.trim();
  if (/^\d+$/.test(plain)) return Number(plain);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(plain);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

/**
 * Extract a video id (and optional start offset) from anything the user pasted.
 * @param {string} input a full URL, a bare id, or whitespace-padded either.
 * @returns {{id: string, start: number}|null} null when no id can be found.
 */
export function parseVideoRef(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  if (ID_RE.test(raw)) return { id: raw, start: 0 };

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  const start = parseTimestamp(url.searchParams.get('t') ?? url.searchParams.get('start'));

  const v = url.searchParams.get('v');
  if (isVideoId(v)) return { id: /** @type {string} */ (v), start };

  if (url.hostname.toLowerCase() === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return isVideoId(id) ? { id, start } : null;
  }

  const m = PATH_RE.exec(url.pathname);
  return m ? { id: m[1], start } : null;
}

/**
 * Canonical watch URL, for the "open on YouTube" attribution link that
 * YouTube's terms require us to keep reachable.
 * @param {string} id
 * @returns {string}
 */
export function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}
