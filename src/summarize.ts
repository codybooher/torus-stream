import type { Config, Reading, WindowSummary } from './types.ts';
import {
  addValue,
  createAccumulator,
  toWindowSummary,
  type WindowAccumulator,
} from './accumulator.ts';
import { createReadingFilter } from './clean.ts';
import { assertValidWindowConfig, compareWindowSummaries, windowStartOf } from './rules.ts';

/**
 * Tier 1. Clean `readings` (given in arrival order) and summarize each
 * device's accepted readings per window. See "Rules" in the README.
 */
export function summarize(readings: Reading[], config: Config): WindowSummary[] {
  assertValidWindowConfig(config);
  const filter = createReadingFilter(config);
  const byDevice = new Map<string, Map<number, WindowAccumulator>>();

  for (const reading of readings) {
    if (filter.classify(reading) !== 'accepted' || reading.value === null) {
      continue;
    }

    let windows = byDevice.get(reading.deviceId);
    if (windows === undefined) {
      windows = new Map();
      byDevice.set(reading.deviceId, windows);
    }

    const windowStart = windowStartOf(reading.ts, config.windowMs);
    const acc = windows.get(windowStart);
    if (acc === undefined) {
      windows.set(windowStart, createAccumulator(reading.value));
    } else {
      addValue(acc, reading.value);
    }
  }

  const summaries: WindowSummary[] = [];
  for (const [deviceId, windows] of byDevice) {
    for (const [windowStart, acc] of windows) {
      summaries.push(toWindowSummary(deviceId, windowStart, acc));
    }
  }

  summaries.sort(compareWindowSummaries);
  return summaries;
}
