import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectGaps, DEFAULT_CONFIG, type Config, type Reading } from '../src/index.ts';

const config: Config = {
  windowMs: 60_000,
  maxLatenessMs: 5_000,
  gapMs: 10_000,
  validRange: { min: -40, max: 125 },
};

let nextSeq = 20_000;
const r = (deviceId: string, ts: number, value: number | null, seq = nextSeq++): Reading => ({
  deviceId,
  ts,
  seq,
  value,
});

test('no readings or a single reading produces no gaps', () => {
  assert.deepEqual(detectGaps([], config), []);
  assert.deepEqual(detectGaps([r('a', 1_000, 10)], config), []);
});

test('requires silence strictly greater than gapMs', () => {
  assert.deepEqual(
    detectGaps([r('a', 1_000, 10), r('a', 11_000, 11)], config),
    [],
  );
  assert.deepEqual(
    detectGaps([r('a', 1_000, 10), r('a', 11_001, 11)], config),
    [{ deviceId: 'a', start: 1_000, end: 11_001 }],
  );
});

test('evaluates gaps in ts order even when readings arrive out of order', () => {
  // 10_000 arrives before 6_000 (within maxLatenessMs=5_000), bridging the gap between 1_000 and 12_000.
  const bridged = detectGaps(
    [r('a', 1_000, 10), r('a', 10_000, 11), r('a', 6_000, 12), r('a', 12_000, 13)],
    config,
  );
  assert.deepEqual(bridged, []);

  // Out-of-order reading that still leaves a gap before it.
  const gapped = detectGaps(
    [r('a', 1_000, 10), r('a', 15_000, 11), r('a', 12_000, 12)],
    config,
  );
  assert.deepEqual(gapped, [{ deviceId: 'a', start: 1_000, end: 12_000 }]);

  // Identical timestamps produce no gap; an out-of-order reading can split one large silence into two.
  const identical = detectGaps([r('a', 5_000, 10), r('a', 5_000, 11)], config);
  assert.deepEqual(identical, []);

  const split = detectGaps(
    [r('a', 0, 10), r('a', 30_000, 11), r('a', 15_000, 12)],
    { ...config, maxLatenessMs: 20_000 },
  );
  assert.deepEqual(split, [
    { deviceId: 'a', start: 0, end: 15_000 },
    { deviceId: 'a', start: 15_000, end: 30_000 },
  ]);
});

test('dropped readings (invalid, duplicate, late) do not bridge a gap', () => {
  const out = detectGaps(
    [
      r('a', 1_000, 10, 1),
      r('a', 6_000, null, 2),       // invalid
      r('a', 6_000, 15, 2),         // duplicate of invalid
      r('a', 15_000, 12, 3),        // accepted -> advances newest to 15_000
      r('a', 9_000, 11, 4),         // late (15_000 - 9_000 = 6_000 > 5_000)
    ],
    config,
  );
  assert.deepEqual(out, [{ deviceId: 'a', start: 1_000, end: 15_000 }]);
});

test('sorts gaps by deviceId (plain string order), then by start', () => {
  const out = detectGaps(
    [
      r('dev-2', 0, 10),
      r('dev-2', 20_000, 10),
      r('dev-10', 50_000, 10),
      r('dev-10', 70_000, 10),
      r('dev-10', 90_000, 10),
      r('B', 0, 10),
      r('B', 15_000, 10),
      r('a', 0, 10),
      r('a', 15_000, 10),
    ],
    config,
  );
  assert.deepEqual(out, [
    { deviceId: 'B', start: 0, end: 15_000 },
    { deviceId: 'a', start: 0, end: 15_000 },
    { deviceId: 'dev-10', start: 50_000, end: 70_000 },
    { deviceId: 'dev-10', start: 70_000, end: 90_000 },
    { deviceId: 'dev-2', start: 0, end: 20_000 },
  ]);
});

test('does not mutate the input array or its reading objects', () => {
  const readings: Reading[] = [r('a', 20_000, 10), r('a', 0, 10)];
  const snapshot = structuredClone(readings);
  for (const reading of readings) Object.freeze(reading);
  Object.freeze(readings);

  detectGaps(readings, { ...config, maxLatenessMs: 30_000 });
  assert.deepEqual(readings, snapshot);
});

test('detects each device silence in data/sample.json', () => {
  const readings: Reading[] = JSON.parse(
    readFileSync(new URL('../data/sample.json', import.meta.url), 'utf8'),
  );
  const gaps = detectGaps(readings, DEFAULT_CONFIG);
  // scripts/generate.ts creates one 15-30 s silence per device across 3 devices.
  const devicesWithLongGap = new Set(
    gaps.filter((g) => g.end - g.start >= 15_000).map((g) => g.deviceId),
  );
  assert.deepEqual([...devicesWithLongGap].sort(), ['dev-01', 'dev-02', 'dev-03']);
  for (const g of gaps) {
    assert.ok(g.end - g.start > DEFAULT_CONFIG.gapMs);
  }
});
