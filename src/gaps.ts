import type { Config, Gap, Reading } from './types.ts';
import { createReadingFilter } from './clean.ts';
import { assertValidConfig, compareDeviceId } from './rules.ts';

/**
 * Tier 2. Report every gap in each device's accepted readings.
 * See "Tier 2" in the README.
 */
export function detectGaps(readings: Reading[], config: Config): Gap[] {
  assertValidConfig(config);
  const filter = createReadingFilter(config);
  const timestampsByDevice = new Map<string, number[]>();

  for (const reading of readings) {
    if (filter.classify(reading) !== 'accepted') {
      continue;
    }

    let timestamps = timestampsByDevice.get(reading.deviceId);
    if (timestamps === undefined) {
      timestamps = [];
      timestampsByDevice.set(reading.deviceId, timestamps);
    }
    timestamps.push(reading.ts);
  }

  const gaps: Gap[] = [];
  for (const [deviceId, timestamps] of timestampsByDevice) {
    timestamps.sort((a, b) => a - b);
    for (let i = 1; i < timestamps.length; i += 1) {
      const start = timestamps[i - 1];
      const end = timestamps[i];
      if (end - start > config.gapMs) {
        gaps.push({ deviceId, start, end });
      }
    }
  }

  gaps.sort((a, b) => compareDeviceId(a.deviceId, b.deviceId) || a.start - b.start);
  return gaps;
}
