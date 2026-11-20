import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createStream,
  DEFAULT_CONFIG,
  summarize,
  type Config,
  type Reading,
  type WindowSummary,
} from '../src/index.ts';
import { createStreamWithStats } from '../src/stream.ts';
import { compareWindowSummaries } from '../src/rules.ts';
import { generate } from '../scripts/generate.ts';

const config: Config = {
  windowMs: 60_000,
  maxLatenessMs: 5_000,
  gapMs: 10_000,
  validRange: { min: -40, max: 125 },
};

let nextSeq = 30_000;
const r = (deviceId: string, ts: number, value: number | null, seq = nextSeq++): Reading => ({
  deviceId,
  ts,
  seq,
  value,
});

function runStream(readings: Reading[], cfg: Config): WindowSummary[] {
  const stream = createStream(cfg);
  const out: WindowSummary[] = [];
  for (const reading of readings) {
    out.push(...stream.push(reading));
  }
  out.push(...stream.end());
  return out;
}

function assertMatchesSummarize(readings: Reading[], cfg: Config): void {
  const expected = summarize(readings, cfg);
  const actual = runStream(readings, cfg);

  // Verify every (deviceId, windowStart) is emitted at most once.
  const keys = new Set(actual.map((w) => `${w.deviceId}\0${w.windowStart}`));
  assert.equal(keys.size, actual.length, 'each window must be emitted exactly once');

  actual.sort(compareWindowSummaries);
  assert.equal(actual.length, expected.length);

  for (let i = 0; i < expected.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    assert.equal(a.deviceId, e.deviceId);
    assert.equal(a.windowStart, e.windowStart);
    assert.equal(a.count, e.count);
    assert.equal(a.min, e.min);
    assert.equal(a.max, e.max);
    assert.equal(a.p95, e.p95);
    assert.ok(
      Math.abs(a.avg - e.avg) <= 1e-9,
      `avg mismatch for ${a.deviceId}@${a.windowStart}: ${a.avg} vs ${e.avg}`,
    );
  }
}

test('empty stream returns no windows, end() is idempotent, and push() after end() throws', () => {
  const stream = createStream(config);
  assert.deepEqual(stream.end(), []);
  assert.deepEqual(stream.end(), []);
  assert.throws(() => stream.push(r('a', 1_000, 10)), /after end\(\)/);
});

test('emits a window at the exact earliest push when it can no longer change', () => {
  const stream = createStream(config);

  assert.deepEqual(stream.push(r('a', 1_000, 10)), []);
  // newest = 64_999 -> watermark = 59_999, so window [0, 60_000) can still receive ts=59_999.
  assert.deepEqual(stream.push(r('a', 64_999, 20)), []);
  assert.deepEqual(stream.push(r('a', 59_999, 30)), []);

  // newest = 65_000 -> watermark = 60_000, so window [0, 60_000) is now final.
  const closed = stream.push(r('a', 65_000, 40));
  assert.deepEqual(closed, [
    { deviceId: 'a', windowStart: 0, count: 2, min: 10, max: 30, avg: 20, p95: 30 },
  ]);

  // Only the remaining open window [60_000, 120_000) comes out on end().
  assert.deepEqual(stream.end(), [
    { deviceId: 'a', windowStart: 60_000, count: 2, min: 20, max: 40, avg: 30, p95: 40 },
  ]);
  assert.deepEqual(stream.end(), []);
});

test('one device advancing does not close a quiet device window until end()', () => {
  const stream = createStream(config);

  assert.deepEqual(stream.push(r('quiet', 1_000, 5)), []);
  assert.deepEqual(stream.push(r('active', 1_000, 10)), []);

  // Advancing `active` closes only `active`'s window.
  const closed = stream.push(r('active', 200_000, 20));
  assert.deepEqual(closed, [
    { deviceId: 'active', windowStart: 0, count: 1, min: 10, max: 10, avg: 10, p95: 10 },
  ]);

  // `quiet` only flushes on end().
  const remaining = stream.end().sort(compareWindowSummaries);
  assert.deepEqual(remaining, [
    { deviceId: 'active', windowStart: 180_000, count: 1, min: 20, max: 20, avg: 20, p95: 20 },
    { deviceId: 'quiet', windowStart: 0, count: 1, min: 5, max: 5, avg: 5, p95: 5 },
  ]);
});

test('invalid readings do not advance the watermark or close windows', () => {
  const stream = createStream(config);
  assert.deepEqual(stream.push(r('a', 1_000, 10)), []);
  assert.deepEqual(stream.push(r('a', 500_000, null)), []);
  assert.deepEqual(stream.push(r('a', 500_000, 9999)), []);
  // Window [0, 60_000) must still be open and accept ts=2_000.
  assert.deepEqual(stream.push(r('a', 2_000, 20)), []);
  assert.deepEqual(stream.end(), [
    { deviceId: 'a', windowStart: 0, count: 2, min: 10, max: 20, avg: 15, p95: 20 },
  ]);
});

test('evicted seqs are still dropped on resend because they are behind the watermark', () => {
  const stream = createStreamWithStats(config);

  assert.deepEqual(stream.push(r('a', 1_000, 10, 1)), []);
  const closed = stream.push(r('a', 100_000, 20, 2));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].windowStart, 0);

  // seq 1's bucket was strictly behind watermark (95_000), so only seq 2 remains tracked.
  assert.equal(stream.stats().trackedSeqs, 1);

  // Resending seq 1 (with its original ts=1_000) is dropped and does not reopen window 0.
  assert.deepEqual(stream.push(r('a', 1_000, 99, 1)), []);
  assert.equal(stream.stats().trackedSeqs, 1);
  assert.deepEqual(stream.end(), [
    { deviceId: 'a', windowStart: 60_000, count: 1, min: 20, max: 20, avg: 20, p95: 20 },
  ]);
});

test('closes multiple open windows in a single push when maxLatenessMs > windowMs', () => {
  const cfg: Config = { ...config, windowMs: 10_000, maxLatenessMs: 25_000 };
  const stream = createStream(cfg);

  assert.deepEqual(stream.push(r('a', 1_000, 1)), []);
  assert.deepEqual(stream.push(r('a', 11_000, 2)), []);
  assert.deepEqual(stream.push(r('a', 21_000, 3)), []);

  // Jump to ts=60_000 -> watermark=35_000 -> windows [0, 10k), [10k, 20k), [20k, 30k) all close.
  const closed = stream.push(r('a', 60_000, 4)).sort(compareWindowSummaries);
  assert.deepEqual(
    closed.map((w) => w.windowStart),
    [0, 10_000, 20_000],
  );
  assert.deepEqual(
    stream.end().map((w) => w.windowStart),
    [60_000],
  );
});

test('drops a valid resend of a previously invalid reading within the lateness horizon', () => {
  const stream = createStream(config);
  assert.deepEqual(stream.push(r('a', 1_000, null, 77)), []);
  assert.deepEqual(stream.push(r('a', 1_000, 25, 77)), []);
  assert.deepEqual(stream.end(), []);
});

test('maxLatenessMs of 0 closes a window immediately at the next boundary and deduplicates same-ts resends', () => {
  const stream = createStream({ ...config, maxLatenessMs: 0 });
  assert.deepEqual(stream.push(r('a', 1_000, null, 1)), []);
  assert.deepEqual(stream.push(r('a', 1_000, 50, 1)), []);
  assert.deepEqual(stream.push(r('a', 1_000, 10, 2)), []);

  // Pushing ts=60_000 moves watermark to 60_000, immediately closing [0, 60_000).
  const closed = stream.push(r('a', 60_000, 20, 3));
  assert.deepEqual(closed, [
    { deviceId: 'a', windowStart: 0, count: 1, min: 10, max: 10, avg: 10, p95: 10 },
  ]);
  assert.deepEqual(stream.end(), [
    { deviceId: 'a', windowStart: 60_000, count: 1, min: 20, max: 20, avg: 20, p95: 20 },
  ]);
});

test('invalid-only stream emits no windows and does not mutate frozen readings', () => {
  const stream = createStream(config);
  const readings = [r('a', 1_000, null), r('a', 2_000, NaN), r('a', 3_000, 999)];
  for (const reading of readings) {
    Object.freeze(reading);
    assert.deepEqual(stream.push(reading), []);
  }
  assert.deepEqual(stream.end(), []);
});

test('matches summarize on data/sample.json', () => {
  const readings: Reading[] = JSON.parse(
    readFileSync(new URL('../data/sample.json', import.meta.url), 'utf8'),
  );
  assertMatchesSummarize(readings, DEFAULT_CONFIG);
});

test('matches summarize across generated datasets and varied configs', () => {
  const configs: Config[] = [
    DEFAULT_CONFIG,
    { ...DEFAULT_CONFIG, windowMs: 10_000, maxLatenessMs: 25_000 }, // L > W (multiple open windows)
    { ...DEFAULT_CONFIG, windowMs: 15_000, maxLatenessMs: 0 },      // L = 0
    { ...DEFAULT_CONFIG, windowMs: 5_000, maxLatenessMs: 5_000 },   // L = W
  ];

  for (const seed of [1, 7, 42]) {
    const readings = generate({ seed, devices: 4, minutes: 5 });
    for (const cfg of configs) {
      assertMatchesSummarize(readings, cfg);
    }
  }
});

test('memory stays bounded and does not grow with stream duration', () => {
  const devices = 5;
  const maxOpenWindowsBound =
    devices * (Math.ceil(DEFAULT_CONFIG.maxLatenessMs / DEFAULT_CONFIG.windowMs) + 1);

  function measurePeak(minutes: number) {
    const readings = generate({ seed: 11, devices, minutes });
    const stream = createStreamWithStats(DEFAULT_CONFIG);
    let peakOpenWindows = 0;
    let peakTrackedSeqs = 0;
    let peakSeqBuckets = 0;

    for (const reading of readings) {
      stream.push(reading);
      const s = stream.stats();
      if (s.openWindows > peakOpenWindows) peakOpenWindows = s.openWindows;
      if (s.trackedSeqs > peakTrackedSeqs) peakTrackedSeqs = s.trackedSeqs;
      if (s.seqBuckets > peakSeqBuckets) peakSeqBuckets = s.seqBuckets;
    }

    stream.end();
    assert.deepEqual(stream.stats(), {
      devices: 0,
      openWindows: 0,
      trackedSeqs: 0,
      seqBuckets: 0,
    });

    return { totalReadings: readings.length, peakOpenWindows, peakTrackedSeqs, peakSeqBuckets };
  }

  const shortRun = measurePeak(30);
  const longRun = measurePeak(120); // 4x longer stream

  assert.ok(shortRun.peakOpenWindows <= maxOpenWindowsBound);
  assert.ok(longRun.peakOpenWindows <= maxOpenWindowsBound);

  // At most ~2-3 live seq buckets per device (bucketMs = maxLatenessMs = 5 s).
  assert.ok(longRun.peakSeqBuckets <= devices * 3);

  // Peak tracked seqs stays O(devices * readings per lateness horizon), not O(totalReadings).
  assert.ok(longRun.peakTrackedSeqs < 150, `peakTrackedSeqs=${longRun.peakTrackedSeqs}`);
  assert.ok(
    longRun.peakTrackedSeqs <= shortRun.peakTrackedSeqs * 1.5,
    `expected flat memory across 4x duration: short=${shortRun.peakTrackedSeqs}, long=${longRun.peakTrackedSeqs}`,
  );
});
