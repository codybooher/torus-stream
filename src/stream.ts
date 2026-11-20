import type { Config, Reading, WindowSummary } from './types.ts';
import {
  addValue,
  createAccumulator,
  toWindowSummary,
  type WindowAccumulator,
} from './accumulator.ts';
import { isTooLate, isValidValue, windowStartOf } from './rules.ts';

export type Stream = {
  /** Accept one reading, in arrival order. Returns any windows that just became final. */
  push(reading: Reading): WindowSummary[];
  /** The input is over. Returns every window still open. */
  end(): WindowSummary[];
};

export type StreamStats = {
  devices: number;
  openWindows: number;
  trackedSeqs: number;
  seqBuckets: number;
};

export type InstrumentedStream = Stream & {
  /** Diagnostic snapshot of live in-memory state (used by memory-bound tests). */
  stats(): StreamStats;
};

type DeviceStreamState = {
  newestAcceptedTs: number;
  windows: Map<number, WindowAccumulator>;
  seenSeqs: Set<number>;
  seqBuckets: Map<number, number[]>;
};

/**
 * Internal factory that exposes live memory counters alongside the `Stream` API.
 */
export function createStreamWithStats(config: Config): InstrumentedStream {
  const devices = new Map<string, DeviceStreamState>();
  // Bucket width for time-based eviction of `seenSeqs`. When `maxLatenessMs > 0`,
  // using `maxLatenessMs` keeps at most ~2 live buckets per active device.
  const bucketMs = config.maxLatenessMs > 0 ? config.maxLatenessMs : 1_000;

  function push(reading: Reading): WindowSummary[] {
    let state = devices.get(reading.deviceId);
    if (state === undefined) {
      state = {
        newestAcceptedTs: -Infinity,
        windows: new Map(),
        seenSeqs: new Set(),
        seqBuckets: new Map(),
      };
      devices.set(reading.deviceId, state);
    }

    // Rule 3 fast-path: a reading strictly behind the lateness watermark is dropped,
    // and any future resend (which carries the same `ts`) will also be late, so we
    // never need to retain its `seq`.
    if (isTooLate(reading.ts, state.newestAcceptedTs, config.maxLatenessMs)) {
      return [];
    }

    // Rule 2: drop duplicates, and record every non-late seq (even if invalid).
    if (state.seenSeqs.has(reading.seq)) {
      return [];
    }
    state.seenSeqs.add(reading.seq);
    const bucketId = Math.floor(reading.ts / bucketMs);
    let bucket = state.seqBuckets.get(bucketId);
    if (bucket === undefined) {
      bucket = [];
      state.seqBuckets.set(bucketId, bucket);
    }
    bucket.push(reading.seq);

    // Rule 1: drop invalid values.
    if (!isValidValue(reading.value, config.validRange)) {
      return [];
    }

    // Accepted: accumulate into the reading's tumbling window.
    const windowStart = windowStartOf(reading.ts, config.windowMs);
    const acc = state.windows.get(windowStart);
    if (acc === undefined) {
      state.windows.set(windowStart, createAccumulator(reading.value));
    } else {
      addValue(acc, reading.value);
    }

    // Watermark only advances when `newestAcceptedTs` strictly increases.
    if (reading.ts <= state.newestAcceptedTs) {
      return [];
    }
    state.newestAcceptedTs = reading.ts;

    const watermark = state.newestAcceptedTs - config.maxLatenessMs;

    // Evict seq buckets whose timestamps are all strictly behind `watermark`.
    // Every `ts` in bucket `b` satisfies `ts < (b + 1) * bucketMs`, so when
    // `b < Math.floor(watermark / bucketMs)` every `ts` in `b` is `< watermark`.
    const evictBeforeBucket = Math.floor(watermark / bucketMs);
    for (const [bId, seqs] of state.seqBuckets) {
      if (bId < evictBeforeBucket) {
        for (const seq of seqs) {
          state.seenSeqs.delete(seq);
        }
        state.seqBuckets.delete(bId);
      }
    }

    // Emit and drop windows that can never receive another accepted reading.
    const closed: WindowSummary[] = [];
    for (const [ws, windowAcc] of state.windows) {
      if (ws + config.windowMs <= watermark) {
        closed.push(toWindowSummary(reading.deviceId, ws, windowAcc));
        state.windows.delete(ws);
      }
    }

    return closed;
  }

  function end(): WindowSummary[] {
    const remaining: WindowSummary[] = [];
    for (const [deviceId, state] of devices) {
      for (const [ws, acc] of state.windows) {
        remaining.push(toWindowSummary(deviceId, ws, acc));
      }
    }
    devices.clear();
    return remaining;
  }

  function stats(): StreamStats {
    let openWindows = 0;
    let trackedSeqs = 0;
    let seqBuckets = 0;
    for (const state of devices.values()) {
      openWindows += state.windows.size;
      trackedSeqs += state.seenSeqs.size;
      seqBuckets += state.seqBuckets.size;
    }
    return {
      devices: devices.size,
      openWindows,
      trackedSeqs,
      seqBuckets,
    };
  }

  return { push, end, stats };
}

/**
 * Tier 2. A streaming version of `summarize` that holds bounded memory.
 * See "Tier 2" in the README.
 */
export function createStream(config: Config): Stream {
  const { push, end } = createStreamWithStats(config);
  return { push, end };
}
