import type { WindowSummary } from './types.ts';

export type WindowAccumulator = {
  count: number;
  sum: number;
  min: number;
  max: number;
};

export function createAccumulator(value: number): WindowAccumulator {
  const v = value === 0 ? 0 : value;
  return { count: 1, sum: v, min: v, max: v };
}

export function addValue(acc: WindowAccumulator, value: number): void {
  const v = value === 0 ? 0 : value;
  acc.count += 1;
  acc.sum += v;
  if (v < acc.min) acc.min = v;
  if (v > acc.max) acc.max = v;
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
  };
}
