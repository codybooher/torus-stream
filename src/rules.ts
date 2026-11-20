import type { Config, WindowSummary } from './types.ts';

/** True when `value` is a finite number within `validRange` (bounds inclusive). */
export function isValidValue(
  value: number | null,
  validRange: Config['validRange'],
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= validRange.min &&
    value <= validRange.max
  );
}

/** True when `ts` lags strictly more than `maxLatenessMs` behind `newestAcceptedTs`. */
export function isTooLate(
  ts: number,
  newestAcceptedTs: number,
  maxLatenessMs: number,
): boolean {
  return newestAcceptedTs - ts > maxLatenessMs;
}

/** Start timestamp (inclusive) of the tumbling window containing `ts`. */
export function windowStartOf(ts: number, windowMs: number): number {
  // Adding 0 normalizes -0 to +0.
  return Math.floor(ts / windowMs) * windowMs + 0;
}

/** Plain UTF-16 code-unit comparison (not `localeCompare`). */
export function compareDeviceId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort comparator for `WindowSummary`: `deviceId` (plain string), then `windowStart`. */
export function compareWindowSummaries(a: WindowSummary, b: WindowSummary): number {
  return compareDeviceId(a.deviceId, b.deviceId) || a.windowStart - b.windowStart;
}
