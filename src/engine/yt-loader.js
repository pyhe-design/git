/**
 * Loads the YouTube IFrame API exactly once per page.
 *
 * EXTERNAL SCRIPT: https://www.youtube.com/iframe_api. It is third-party code
 * from Google and it is not optional -- it is the only sanctioned way to control
 * an embedded player, and YouTube's terms forbid extracting the stream instead.
 * It installs `window.YT` and calls `window.onYouTubeIframeAPIReady`.
 */

const API_SRC = 'https://www.youtube.com/iframe_api';

/** @type {Promise<typeof globalThis.YT>|null} */
let pending = null;

/**
 * @param {number} [timeoutMs] how long to wait before reporting the script blocked.
 * @returns {Promise<any>} resolves with the `YT` namespace.
 */
export function loadYouTubeApi(timeoutMs = 15000) {
  if (pending) return pending;

  pending = new Promise((resolve, reject) => {
    /** @type {any} */
    const g = globalThis;
    if (g.YT && typeof g.YT.Player === 'function') {
      resolve(g.YT);
      return;
    }

    const timer = setTimeout(() => {
      pending = null;
      reject(
        new Error(
          'The YouTube IFrame API did not load. A content blocker, an offline ' +
            'network or a restrictive CSP will all cause this.',
        ),
      );
    }, timeoutMs);

    // The API calls this global when it is ready; chain any existing handler.
    const previous = g.onYouTubeIframeAPIReady;
    g.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (typeof previous === 'function') previous();
      resolve(g.YT);
    };

    const existing = document.querySelector(`script[src="${API_SRC}"]`);
    if (existing) return;

    const script = document.createElement('script');
    script.src = API_SRC;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      pending = null;
      reject(new Error('Failed to fetch the YouTube IFrame API script.'));
    };
    document.head.append(script);
  });

  return pending;
}

/** Test seam: forget the cached load so a stub can be installed. */
export function resetYouTubeApiForTests() {
  pending = null;
}
