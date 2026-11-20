import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStream, detectGaps, summarize, type Config, type Reading } from '../src/index.ts';

const config: Config = {
  windowMs: 60_000,
  maxLatenessMs: 5_000,
  gapMs: 10_000,
  validRange: { min: -40, max: 125 },
};

let nextSeq = 10_000;
const r = (deviceId: string, ts: number, value: number | null, seq = nextSeq++): Reading => ({
  deviceId,
  ts,
  seq,
  value,
});

test('drops -Infinity and normalizes -0 values to +0', () => {
  const out = summarize([r('a', 1_000, -Infinity), r('a', 2_000, -0)], config);
  assert.deepEqual(out, [{ deviceId: 'a', windowStart: 0, count: 1, min: 0, max: 0, avg: 0, p95: 0 }]);
  assert.ok(Object.is(out[0].min, 0));
  assert.ok(Object.is(out[0].max, 0));
  assert.ok(Object.is(out[0].avg, 0));
  assert.ok(Object.is(out[0].p95, 0));
});

test('drops a valid resend of a previously invalid reading', () => {
  const out = summarize(
    [r('a', 1_000, null, 42), r('a', 1_000, 20, 42), r('a', 2_000, 999, 43), r('a', 2_000, 25, 43)],
    config,
  );
  assert.deepEqual(out, []);
});

test('drops a resend of a previously late reading', () => {
  const out = summarize(
    [r('a', 20_000, 10, 1), r('a', 10_000, 50, 2), r('a', 10_000, 50, 2)],
    config,
  );
  assert.deepEqual(out, [{ deviceId: 'a', windowStart: 0, count: 1, min: 10, max: 10, avg: 10, p95: 10 }]);
});

test('a duplicate arrival does not move newestAcceptedTs forward', () => {
  // seq 1 arrives at ts=10_000 (accepted). A pathological duplicate with seq 1 at ts=100_000
  // must be dropped as a duplicate and not advance newestAcceptedTs.
  const out = summarize(
    [r('a', 10_000, 1, 1), r('a', 100_000, 99, 1), r('a', 10_500, 3, 2)],
    config,
  );
  assert.deepEqual(out, [{ deviceId: 'a', windowStart: 0, count: 2, min: 1, max: 3, avg: 2, p95: 3 }]);
});

test('handles zero and negative timestamps with floor-based tumbling windows', () => {
  const out = summarize(
    [r('a', -1, 10), r('a', -0, 20), r('a', 0, 30)],
    { ...config, maxLatenessMs: 100_000 },
  );
  assert.deepEqual(out, [
    { deviceId: 'a', windowStart: -60_000, count: 1, min: 10, max: 10, avg: 10, p95: 10 },
    { deviceId: 'a', windowStart: 0, count: 2, min: 20, max: 30, avg: 25, p95: 30 },
  ]);
  assert.ok(Object.is(out[1].windowStart, 0));
});

test('maxLatenessMs of 0 accepts equal timestamps and drops strictly older ones', () => {
  const out = summarize(
    [r('a', 10_000, 1), r('a', 10_000, 3), r('a', 9_999, 100)],
    { ...config, maxLatenessMs: 0 },
  );
  assert.deepEqual(out, [{ deviceId: 'a', windowStart: 0, count: 2, min: 1, max: 3, avg: 2, p95: 3 }]);
});

test('sorts deviceId using plain string comparison, not localeCompare', () => {
  // In UTF-16 code-unit order: 'B' (66) < 'a' (97), and 'dev-10' < 'dev-2'.
  const out = summarize(
    [r('a', 1_000, 1), r('B', 1_000, 1), r('dev-2', 1_000, 1), r('dev-10', 1_000, 1)],
    config,
  );
  assert.deepEqual(
    out.map((w) => w.deviceId),
    ['B', 'a', 'dev-10', 'dev-2'],
  );
});

test('does not mutate the input array or its reading objects', () => {
  const readings: Reading[] = [
    r('b', 65_000, 20),
    r('a', 10_000, 10),
    r('a', 5_000, 30),
    r('b', 60_000, null),
  ];
  const snapshot = structuredClone(readings);
  for (const reading of readings) {
    Object.freeze(reading);
  }
  Object.freeze(readings);

  const out = summarize(readings, config);
  assert.equal(out.length, 2);
  assert.deepEqual(readings, snapshot);
});

test('computes exact nearest-rank p95 across sample sizes and unsorted inputs', () => {
  // 20 values 1..20 in reverse order -> ceil(0.95 * 20) = 19th smallest = 19.
  const twenty = Array.from({ length: 20 }, (_, i) => r('a', 1_000 + i * 100, 20 - i));
  assert.equal(summarize(twenty, config)[0].p95, 19);

  // 21 values 1..21 -> ceil(0.95 * 21) = 20th smallest = 20.
  const twentyOne = Array.from({ length: 21 }, (_, i) => r('a', 1_000 + i * 100, i + 1));
  assert.equal(summarize(twentyOne, config)[0].p95, 20);

  // 100 values 1..100 -> ceil(0.95 * 100) = 95th smallest = 95.
  const hundred = Array.from({ length: 100 }, (_, i) => r('a', 1_000 + i * 10, 100 - i));
  assert.equal(summarize(hundred, config)[0].p95, 95);

  // Negative values and duplicates verify numeric (not lexicographic) sorting and tie handling.
  const negAndTies = [
    r('a', 1_000, -10),
    r('a', 2_000, -40),
    r('a', 3_000, -2),
    r('a', 4_000, -40),
    r('a', 5_000, 0),
  ];
  assert.equal(summarize(negAndTies, config)[0].p95, 0);
});

test('rejects invalid config values across summarize, detectGaps, and createStream', () => {
  const badConfigs: Config[] = [
    { ...config, windowMs: 0 },
    { ...config, windowMs: -1_000 },
    { ...config, windowMs: NaN },
    { ...config, maxLatenessMs: -1 },
    { ...config, gapMs: -1 },
    { ...config, validRange: { min: 10, max: 5 } },
    { ...config, validRange: { min: -Infinity, max: 10 } },
  ];

  for (const bad of badConfigs) {
    assert.throws(() => summarize([], bad), RangeError);
    assert.throws(() => detectGaps([], bad), RangeError);
    assert.throws(() => createStream(bad), RangeError);
  }
});
