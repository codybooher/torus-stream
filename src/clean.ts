import type { Config, Reading } from './types.ts';
import { isTooLate, isValidValue } from './rules.ts';

export type ReadingVerdict = 'accepted' | 'duplicate' | 'invalid' | 'late';

export type ReadingFilter = {
  classify(reading: Reading): ReadingVerdict;
};

type DeviceFilterState = {
  seenSeqs: Set<number>;
  newestAcceptedTs: number;
};

/**
 * Stateful reading filter enforcing Rules 1-3 in arrival order.
 * Shared by batch operations (`summarize`, `detectGaps`).
 */
export function createReadingFilter(config: Config): ReadingFilter {
  const devices = new Map<string, DeviceFilterState>();

  return {
    classify(reading: Reading): ReadingVerdict {
      let state = devices.get(reading.deviceId);
      if (state === undefined) {
        state = { seenSeqs: new Set(), newestAcceptedTs: -Infinity };
        devices.set(reading.deviceId, state);
      }

      // Rule 2: a resent (deviceId, seq) is always a duplicate, even if the first was dropped.
      if (state.seenSeqs.has(reading.seq)) {
        return 'duplicate';
      }
      state.seenSeqs.add(reading.seq);

      // Rule 1: value must be finite and within validRange (bounds inclusive).
      if (!isValidValue(reading.value, config.validRange)) {
        return 'invalid';
      }

      // Rule 3: ts must not lag more than maxLatenessMs behind newest accepted ts.
      if (isTooLate(reading.ts, state.newestAcceptedTs, config.maxLatenessMs)) {
        return 'late';
      }

      if (reading.ts > state.newestAcceptedTs) {
        state.newestAcceptedTs = reading.ts;
      }
      return 'accepted';
    },
  };
}
