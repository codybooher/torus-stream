import type { WindowSummary } from './types.ts';

export type WindowAccumulator = {
  count: number;
  sum: number;
  min: number;
  max: number;
  values: number[];
};

export function createAccumulator(value: number): WindowAccumulator {
  const v = value === 0 ? 0 : value;
  return { count: 1, sum: v, min: v, max: v, values: [v] };
}

export function addValue(acc: WindowAccumulator, value: number): void {
  const v = value === 0 ? 0 : value;
  acc.count += 1;
  acc.sum += v;
  if (v < acc.min) acc.min = v;
  if (v > acc.max) acc.max = v;
  acc.values.push(v);
}

/** Exact nearest-rank 95th percentile: `sorted[ceil(0.95 * n) - 1]`. */
function computeExactP95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  // Integer ceiling division avoids IEEE-754 drift in `0.95 * n`.
  const index = Math.floor((95 * sorted.length + 99) / 100) - 1;
  return sorted[index];
}

export function toWindowSummary(
  deviceId: string,
  windowStart: number,
  acc: WindowAccumulator,
): WindowSummary {
  return {
    deviceId,
    windowStart,
    count: acc.count,
    min: acc.min,
    max: acc.max,
    avg: acc.sum / acc.count,
    p95: computeExactP95(acc.values),
  };
}
