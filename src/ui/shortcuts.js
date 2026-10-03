/**
 * Keyboard control. DJ muscle memory matters more than discoverability here,
 * so the bindings are two-handed: left hand drives deck A, right hand deck B.
 *
 * Nothing fires while focus sits in a text field, a select or a slider, so
 * typing a URL or arrowing a fader never triggers a transport command.
 */

/** @typedef {{keys: string, label: string, run: () => void}} Binding */

/**
 * @param {KeyboardEvent} event
 * @returns {boolean} true when the event came from somewhere that owns its keys.
 */
export function isTypingTarget(event) {
  const el = /** @type {HTMLElement|null} */ (event.target);
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = /** @type {HTMLInputElement} */ (el).type;
    return type !== 'button' && type !== 'checkbox' && type !== 'radio';
  }
  return false;
}

/**
 * The binding table. Returned as data so the UI can render the same list it
 * registers, and the two can never drift apart.
 *
 * @param {object} actions
 * @param {(side: 'a'|'b') => void} actions.togglePlay
 * @param {(side: 'a'|'b') => void} actions.cue
 * @param {(side: 'a'|'b') => void} actions.toggleMute
 * @param {(delta: number) => void} actions.moveFader
 * @param {(side: 'a'|'b') => void} actions.autoFade
 * @param {() => void} actions.toggleSync
 * @param {() => void} actions.alignBeats
 * @param {(delta: number) => void} actions.nudge
 * @param {(side: 'a'|'b') => void} actions.tap
 * @returns {Binding[]}
 */
export function bindings(actions) {
  return [
    { keys: 'q', label: 'Play / pause deck A', run: () => actions.togglePlay('a') },
    { keys: 'p', label: 'Play / pause deck B', run: () => actions.togglePlay('b') },
    { keys: 'a', label: 'Jump deck A to its first cue', run: () => actions.cue('a') },
    { keys: 'l', label: 'Jump deck B to its first cue', run: () => actions.cue('b') },
    { keys: 'w', label: 'Kill deck A', run: () => actions.toggleMute('a') },
    { keys: 'o', label: 'Kill deck B', run: () => actions.toggleMute('b') },
    { keys: 'e', label: 'Tap tempo, deck A', run: () => actions.tap('a') },
    { keys: 'i', label: 'Tap tempo, deck B', run: () => actions.tap('b') },
    { keys: 'ArrowLeft', label: 'Crossfade toward A', run: () => actions.moveFader(-0.05) },
    { keys: 'ArrowRight', label: 'Crossfade toward B', run: () => actions.moveFader(0.05) },
    { keys: '1', label: 'Auto-fade to deck A', run: () => actions.autoFade('a') },
    { keys: '2', label: 'Auto-fade to deck B', run: () => actions.autoFade('b') },
    { keys: 's', label: 'Toggle sync lock', run: () => actions.toggleSync() },
    { keys: 'd', label: 'Align beat phase', run: () => actions.alignBeats() },
    { keys: '[', label: 'Nudge follower back 50 ms', run: () => actions.nudge(-0.05) },
    { keys: ']', label: 'Nudge follower on 50 ms', run: () => actions.nudge(0.05) },
  ];
}

/**
 * Attach the bindings to a target. Returns a detach function.
 * @param {EventTarget} target
 * @param {Binding[]} table
 * @returns {() => void}
 */
export function attachShortcuts(target, table) {
  /** @type {Map<string, Binding>} */
  const byKey = new Map(table.map((b) => [b.keys.toLowerCase(), b]));

  /** @param {Event} event */
  const onKeyDown = (event) => {
    const e = /** @type {KeyboardEvent} */ (event);
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e)) return;
    const binding = byKey.get(e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
    if (!binding) return;
    e.preventDefault();
    binding.run();
  };

  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
