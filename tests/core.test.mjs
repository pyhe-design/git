/** Unit tests for the pure modules. Run: npm test */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { isVideoId, parseTimestamp, parseVideoRef, watchUrl } from '../src/core/youtube-url.js';
import {
  autoFadeStep,
  clamp,
  crossfadeGains,
  describePosition,
  gainToDb,
  needsVolumeWrite,
  stageVolume,
} from '../src/core/crossfade.js';
import {
  applyCorrection,
  captureOffset,
  createSyncState,
  decideCorrection,
  driftOf,
  formatDrift,
  nudgeOffset,
  SEEK_RESOLUTION,
} from '../src/core/sync.js';
import {
  beatCount,
  beatPhase,
  createTapState,
  formatClock,
  normalizeBpm,
  phaseDelta,
  phaseDeltaSeconds,
  tap,
  tappedBpm,
} from '../src/core/tempo.js';
import { coerceSession, defaultSession, loadSession, saveSession, THEMES } from '../src/core/store.js';

const ID = 'dQw4w9WgXcQ';

describe('youtube-url', () => {
  it('accepts a bare video id', () => {
    assert.deepEqual(parseVideoRef(ID), { id: ID, start: 0 });
    assert.deepEqual(parseVideoRef(`  ${ID}  `), { id: ID, start: 0 });
  });

  it('accepts every URL shape a DJ will paste', () => {
    const cases = [
      `https://www.youtube.com/watch?v=${ID}`,
      `http://youtube.com/watch?v=${ID}&list=PL123`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/v/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `www.youtube.com/watch?v=${ID}`,
    ];
    for (const input of cases) {
      assert.equal(parseVideoRef(input)?.id, ID, input);
    }
  });

  it('carries a start offset across both parameter names and both formats', () => {
    assert.equal(parseVideoRef(`https://youtu.be/${ID}?t=90`)?.start, 90);
    assert.equal(parseVideoRef(`https://youtu.be/${ID}?t=1m30s`)?.start, 90);
    assert.equal(parseVideoRef(`https://youtu.be/${ID}?t=1h2m3s`)?.start, 3723);
    assert.equal(parseVideoRef(`https://www.youtube.com/watch?v=${ID}&start=12`)?.start, 12);
  });

  it('rejects anything that is not a YouTube video', () => {
    for (const input of [
      '',
      '   ',
      'not a url',
      'https://vimeo.com/123456',
      'https://youtube.com/watch?v=short',
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)',
      `javascript://youtube.com/watch?v=${ID}`,
      null,
      undefined,
      42,
    ]) {
      assert.equal(parseVideoRef(/** @type {never} */ (input)), null, String(input));
    }
  });

  it('validates ids and builds attribution links', () => {
    assert.ok(isVideoId(ID));
    assert.ok(!isVideoId('too-short'));
    assert.ok(!isVideoId('has a space'));
    assert.equal(watchUrl(ID), `https://www.youtube.com/watch?v=${ID}`);
    assert.equal(parseTimestamp('garbage'), 0);
    assert.equal(parseTimestamp(null), 0);
  });
});

describe('crossfade', () => {
  it('clamps', () => {
    assert.equal(clamp(-1, 0, 1), 0);
    assert.equal(clamp(2, 0, 1), 1);
    assert.equal(clamp(0.5, 0, 1), 0.5);
  });

  it('holds summed power constant on the equal-power curve', () => {
    for (let i = 0; i <= 20; i += 1) {
      const { a, b } = crossfadeGains(i / 20, 'equal-power');
      assert.ok(Math.abs(a * a + b * b - 1) < 1e-9, `power at ${i / 20}`);
    }
  });

  it('puts the equal-power centre at -3 dB, not -6', () => {
    const centre = crossfadeGains(0.5, 'equal-power');
    assert.ok(Math.abs(gainToDb(centre.a) + 3.01) < 0.02);
    const linear = crossfadeGains(0.5, 'linear');
    assert.ok(Math.abs(gainToDb(linear.a) + 6.02) < 0.02);
  });

  it('keeps both decks open across the middle of the sharp curve', () => {
    for (const x of [0.2, 0.5, 0.8]) {
      const { a, b } = crossfadeGains(x, 'sharp');
      assert.equal(a, 1, `a at ${x}`);
      assert.equal(b, 1, `b at ${x}`);
    }
    assert.equal(crossfadeGains(0, 'sharp').b, 0);
    assert.equal(crossfadeGains(1, 'sharp').a, 0);
  });

  it('hits hard zero and hard one at the ends of every curve', () => {
    for (const curve of /** @type {const} */ (['equal-power', 'linear', 'sharp'])) {
      assert.equal(crossfadeGains(0, curve).a, 1, curve);
      assert.equal(crossfadeGains(0, curve).b, 0, curve);
      assert.equal(crossfadeGains(1, curve).b, 1, curve);
      assert.ok(crossfadeGains(1, curve).a < 1e-12, curve);
    }
  });

  it('survives junk positions and unknown curves', () => {
    assert.deepEqual(crossfadeGains(-5), crossfadeGains(0));
    assert.deepEqual(crossfadeGains(99), crossfadeGains(1));
    assert.deepEqual(
      crossfadeGains(Number.NaN),
      crossfadeGains(0.5),
      'NaN falls back to centre',
    );
    assert.deepEqual(crossfadeGains(0.3, /** @type {never} */ ('nonsense')), crossfadeGains(0.3, 'equal-power'));
  });

  it('collapses the gain chain into an integer the API accepts', () => {
    assert.equal(stageVolume({ fade: 1, trim: 1, master: 1 }), 100);
    assert.equal(stageVolume({ fade: 1, trim: 1, master: 0 }), 0);
    assert.equal(stageVolume({ fade: 0.5, trim: 0.5, master: 1 }), 25);
    assert.equal(stageVolume({ fade: 1, trim: 1, master: 1, muted: true }), 0);
    assert.equal(stageVolume({ fade: 5, trim: 5, master: 5 }), 100, 'out-of-range clamps');
    assert.equal(stageVolume({ fade: -1, trim: 1, master: 1 }), 0);
    assert.ok(Number.isInteger(stageVolume({ fade: 0.707, trim: 0.83, master: 0.91 })));
  });

  it('only spends a player call when the integer actually changed', () => {
    assert.equal(needsVolumeWrite(null, 0), true, 'first write always goes');
    assert.equal(needsVolumeWrite(42, 42), false);
    assert.equal(needsVolumeWrite(42, 43), true);
  });

  it('floors the dB readout instead of returning -Infinity', () => {
    assert.equal(gainToDb(0), -60);
    assert.equal(gainToDb(1), 0);
    assert.ok(Number.isFinite(gainToDb(-1)));
  });

  it('walks an auto-fade to completion and reports done exactly once at the end', () => {
    assert.deepEqual(autoFadeStep(0, 1, 0, 1000), { position: 0, done: false });
    assert.deepEqual(autoFadeStep(0, 1, 500, 1000), { position: 0.5, done: false });
    assert.deepEqual(autoFadeStep(0, 1, 1000, 1000), { position: 1, done: true });
    assert.deepEqual(autoFadeStep(0, 1, 5000, 1000), { position: 1, done: true });
    assert.deepEqual(autoFadeStep(0.25, 0, 0, 0), { position: 0, done: true }, 'zero duration jumps');
  });

  it('describes the fader for assistive tech', () => {
    assert.equal(describePosition(0), 'Deck A only');
    assert.equal(describePosition(1), 'Deck B only');
    assert.equal(describePosition(0.5), 'Both decks equal');
    assert.equal(describePosition(0.9), '90% toward deck B');
    assert.equal(describePosition(0.1), '90% toward deck A');
  });
});

describe('sync', () => {
  /** @param {Partial<import('../src/core/sync.js').SyncState>} [patch] */
  const state = (patch = {}) => ({ ...createSyncState(), enabled: true, ...patch });

  it('captures and measures an offset', () => {
    assert.equal(captureOffset(10, 12), 2);
    assert.equal(driftOf(10, 12, 2), 0);
    assert.equal(driftOf(10, 13, 2), 1);
    assert.equal(captureOffset(Number.NaN, 5), 5, 'junk clocks read as zero');
  });

  it('does nothing while sync is off', () => {
    const d = decideCorrection({
      state: state({ enabled: false }),
      leaderTime: 0,
      followerTime: 99,
      bothPlaying: true,
      now: 1000,
    });
    assert.equal(d.action, 'none');
    assert.equal(d.reason, 'sync off');
  });

  it('refuses to correct unless both decks are playing', () => {
    const d = decideCorrection({
      state: state({ offset: 0 }),
      leaderTime: 0,
      followerTime: 3,
      bothPlaying: false,
      now: 1000,
    });
    assert.equal(d.action, 'none');
  });

  it('absorbs small drift in the deadband rather than seeking', () => {
    const d = decideCorrection({
      state: state({ offset: 0 }),
      leaderTime: 10,
      followerTime: 10.2,
      bothPlaying: true,
      now: 10_000,
    });
    assert.equal(d.action, 'none');
    assert.equal(d.reason, 'locked');
  });

  it('seeks the follower onto the lock when drift leaves the deadband', () => {
    const d = decideCorrection({
      state: state({ offset: 2 }),
      leaderTime: 10,
      followerTime: 13,
      bothPlaying: true,
      now: 10_000,
    });
    assert.equal(d.action, 'seek');
    assert.equal(d.target, 12);
  });

  it('never seeks to a negative time', () => {
    // Offset would put the follower before the start of its video.
    const d = decideCorrection({
      state: state({ offset: -3 }),
      leaderTime: 1,
      followerTime: 1,
      bothPlaying: true,
      now: 10_000,
    });
    assert.equal(d.action, 'seek');
    assert.equal(d.target, 0, 'clamped to the start rather than going negative');
  });

  it('rate-limits corrections so the player is not forced to re-buffer repeatedly', () => {
    const first = decideCorrection({
      state: state({ offset: 0 }),
      leaderTime: 10,
      followerTime: 12,
      bothPlaying: true,
      now: 10_000,
    });
    assert.equal(first.action, 'seek');
    const after = applyCorrection(state({ offset: 0 }), first, 10_000);
    assert.equal(after.corrections, 1);
    assert.equal(after.lastCorrectionAt, 10_000);
    const second = decideCorrection({
      state: after,
      leaderTime: 11,
      followerTime: 13,
      bothPlaying: true,
      now: 10_500,
    });
    assert.equal(second.action, 'none');
    assert.equal(second.reason, 'correction cooling down');
  });

  it('gives up and releases the lock when the user scrubs', () => {
    const d = decideCorrection({
      state: state({ offset: 0 }),
      leaderTime: 10,
      followerTime: 120,
      bothPlaying: true,
      now: 10_000,
    });
    assert.equal(d.action, 'abandon');
    assert.equal(applyCorrection(state({ offset: 0 }), d, 10_000).enabled, false);
  });

  it('leaves state untouched when no correction happened', () => {
    const before = state({ offset: 0 });
    const d = decideCorrection({
      state: before,
      leaderTime: 10,
      followerTime: 10,
      bothPlaying: true,
      now: 1,
    });
    assert.equal(applyCorrection(before, d, 1), before);
  });

  it('ignores nudges finer than the player can honour', () => {
    assert.equal(nudgeOffset(1, 0.001), 1);
    assert.equal(nudgeOffset(1, SEEK_RESOLUTION), 1.05);
    assert.equal(nudgeOffset(1, -0.25), 0.75);
  });

  it('formats drift with a sign', () => {
    assert.equal(formatDrift(0), '0 ms');
    assert.equal(formatDrift(0.12), '+120 ms');
    assert.equal(formatDrift(-0.12), '−120 ms');
    assert.equal(formatDrift(Number.NaN), '0 ms');
  });
});

describe('tempo', () => {
  /** @param {number[]} gaps @returns {import('../src/core/tempo.js').TapState} */
  const tapsWithGaps = (gaps) => {
    let state = createTapState();
    let now = 1_000;
    state = tap(state, now);
    for (const gap of gaps) {
      now += gap;
      state = tap(state, now);
    }
    return state;
  };

  it('needs four taps before committing to a number', () => {
    assert.equal(tappedBpm(tapsWithGaps([500])), null);
    assert.equal(tappedBpm(tapsWithGaps([500, 500])), null);
    assert.equal(tappedBpm(tapsWithGaps([500, 500, 500])), 120);
  });

  it('uses the median so one fumbled tap does not move the estimate', () => {
    const clean = tapsWithGaps([500, 500, 500, 500, 500]);
    const fumbled = tapsWithGaps([500, 500, 1400, 500, 500]);
    assert.equal(tappedBpm(clean), 120);
    assert.equal(tappedBpm(fumbled), 120, 'median ignores the outlier');
  });

  it('starts a new measurement after a long pause', () => {
    let state = tapsWithGaps([500, 500, 500]);
    assert.equal(tappedBpm(state), 120);
    state = tap(state, 1_000 + 1_500 + 10_000);
    assert.equal(state.taps.length, 1);
    assert.equal(tappedBpm(state), null);
  });

  it('rejects tempos outside anything a DJ would play', () => {
    assert.equal(tappedBpm(tapsWithGaps([100, 100, 100])), null, '600 BPM');
    assert.equal(tappedBpm(tapsWithGaps([5000, 5000, 5000])), null, '12 BPM');
  });

  it('folds a half- or double-time tap into range', () => {
    assert.equal(normalizeBpm(170), 170);
    assert.equal(normalizeBpm(340), 170);
    assert.equal(normalizeBpm(30), 60, 'doubles only until it clears the floor');
    assert.equal(normalizeBpm(0), 0);
  });

  it('reports beat phase and beat number against an anchor', () => {
    assert.equal(beatPhase(0, 120), 0);
    assert.equal(beatPhase(0.25, 120), 0.5);
    assert.equal(beatPhase(0.5, 120), 0);
    assert.ok(beatPhase(-0.25, 120) > 0, 'phase stays positive before the anchor');
    assert.equal(beatPhase(10, 0), 0, 'no BPM means no phase');
    assert.equal(beatPhase(10.5, 120, 10), 0, 'anchored');
    assert.equal(beatCount(2, 120), 4);
    assert.equal(beatCount(2, 120, 1), 2);
    assert.equal(beatCount(1, 0), 0);
  });

  it('takes the short way round when comparing phases', () => {
    /** @param {number} actual @param {number} expected @param {string} [note] */
    const near = (actual, expected, note) =>
      assert.ok(Math.abs(actual - expected) < 1e-9, `${note ?? ''} got ${actual}, want ${expected}`);

    near(phaseDelta(0.9, 0.1), 0.2, 'wraps forward across the downbeat');
    near(phaseDelta(0.1, 0.9), -0.2, 'wraps backward');
    near(phaseDelta(0.25, 0.25), 0, 'aligned');
    for (let i = 0; i <= 20; i += 1) {
      for (let j = 0; j <= 20; j += 1) {
        assert.ok(Math.abs(phaseDelta(i / 20, j / 20)) <= 0.5 + 1e-9);
      }
    }
    assert.equal(phaseDeltaSeconds(0.5, 120), -0.25);
    assert.equal(phaseDeltaSeconds(0.5, 0), 0);
  });

  it('formats clocks, including the unknown-duration case', () => {
    assert.equal(formatClock(0), '0:00');
    assert.equal(formatClock(95), '1:35');
    assert.equal(formatClock(3725), '1:02:05');
    assert.equal(formatClock(Number.NaN), '-:--');
    assert.equal(formatClock(-5), '-:--');
  });
});

describe('store', () => {
  /** @returns {import('../src/core/store.js').StorageLike & {raw: Map<string, string>}} */
  const memory = () => {
    const raw = new Map();
    return {
      raw,
      getItem: (k) => raw.get(k) ?? null,
      setItem: (k, v) => void raw.set(k, v),
    };
  };

  it('round-trips a session', () => {
    const storage = memory();
    const session = defaultSession();
    session.theme = 'amber';
    session.decks.a.videoId = ID;
    session.decks.b.bpm = 128;
    assert.equal(saveSession(storage, session), true);
    const back = loadSession(storage);
    assert.equal(back.theme, 'amber');
    assert.equal(back.decks.a.videoId, ID);
    assert.equal(back.decks.b.bpm, 128);
  });

  it('starts from defaults when storage is empty or corrupt', () => {
    assert.equal(loadSession(memory()).theme, 'midnight');
    const broken = memory();
    broken.raw.set('ytdj.session.v1', '{not json');
    assert.deepEqual(loadSession(broken), defaultSession());
  });

  it('reports failure instead of throwing when storage rejects a write', () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    assert.equal(saveSession(hostile, defaultSession()), false);
  });

  it('scrubs hostile or stale payloads field by field', () => {
    const coerced = coerceSession({
      theme: '"><script>alert(1)</script>',
      curve: 'not-a-curve',
      master: 9000,
      position: -4,
      fadeSeconds: 0,
      privacyMode: 'yes',
      decks: {
        a: { videoId: '../../../etc/passwd', trim: -3, bpm: 9999, cues: 'nope' },
        b: null,
      },
    });
    assert.equal(coerced.theme, 'midnight');
    assert.equal(coerced.curve, 'equal-power');
    assert.equal(coerced.master, 1);
    assert.equal(coerced.position, 0);
    assert.equal(coerced.fadeSeconds, 0.5);
    assert.equal(coerced.privacyMode, true);
    assert.equal(coerced.decks.a.videoId, null);
    assert.equal(coerced.decks.a.trim, 0);
    assert.deepEqual(coerced.decks.a.cues, []);
    assert.deepEqual(coerced.decks.b, defaultSession().decks.b);
  });

  it('caps cue lists so a crafted payload cannot grow without bound', () => {
    const coerced = coerceSession({ decks: { a: { cues: Array.from({ length: 500 }, (_, i) => i) } } });
    assert.equal(coerced.decks.a.cues.length, 8);
  });

  it('keeps every theme id addressable from the picker', () => {
    for (const t of THEMES) {
      assert.equal(coerceSession({ theme: t.id }).theme, t.id);
      assert.ok(t.scheme === 'dark' || t.scheme === 'light');
    }
  });
});
