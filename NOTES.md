# Engineering Notes

## What Was Completed

- **Tier 1 (`summarize`)**: Single-pass arrival-order cleaning and tumbling-window aggregation in `src/summarize.ts`, backed by shared helpers (`src/rules.ts`, `src/accumulator.ts`, `src/clean.ts`) and expanded edge-case tests (`test/rules.test.ts`). Zero runtime dependencies, zero input mutation, and `src/index.ts` exports unchanged.
- **Tier 2a (`detectGaps`)**: Reuses the shared reading filter in `src/gaps.ts`, sorts each device's accepted timestamps numerically, emits `{ deviceId, start, end }` wherever `end - start > gapMs`, and sorts by plain UTF-16 `deviceId` then `start`. Tested in `test/gaps.test.ts`.
- **Tier 2b (`createStream`)**: Bounded-memory streaming summarizer in `src/stream.ts` with per-device watermarks and time-bucketed deduplication eviction. Verified in `test/stream.test.ts` with behavioral tests, differential tests against `summarize` across varied configs/seeds, and a 30-min vs. 120-min memory-bound test using `createStreamWithStats`.
- **Tier 3 (`p95`)**: Added exact nearest-rank `p95` (`sorted[ceil(0.95 * n) - 1]`) to `WindowSummary` and updated Tier 1–2 tests to assert on it.

## Key Design Decisions

### Classification Order (Rules 1–3)
Readings are classified in arrival order as `duplicate → invalid → late → accepted`:
1. Check `seenSeqs` first and always record `seq` (even if the reading is later dropped as invalid or late) so a subsequent valid resend is still dropped as a duplicate.
2. Validate `value` (`typeof === 'number'`, `Number.isFinite`, inclusive `validRange`).
3. Check lateness against `newestAcceptedTs` (`newestAcceptedTs - ts > maxLatenessMs`).
4. Only accepted readings advance `newestAcceptedTs` and update window accumulators.

`-0` values and window starts are normalized to `+0` so strict `Object.is` assertions behave consistently. `deviceId` sorting uses plain `< / >` UTF-16 code-unit order rather than `localeCompare`.

### Streaming Memory Bound & Honest Limits
For each device with newest accepted timestamp `N`, lateness `L = maxLatenessMs`, and window width `W = windowMs`, define `watermark = N - L`:
- **Window closure**: Any future accepted reading must satisfy `ts >= watermark`. A window `[ws, ws + W)` can never change once `ws + W <= watermark`, so it is emitted and deleted immediately. Each device holds at most `ceil(L / W) + 1` open windows. Quiet devices keep their windows open until `end()`.
- **Bounded deduplication**: A resend carries the same `ts` as the original. Any arrival with `ts < watermark` is dropped as late without inserting into `seenSeqs`, and any future resend of it will also be late. Non-late `seq`s are indexed in time buckets of width `bucketMs = L > 0 ? L : 1_000`; whenever `N` advances, any bucket `b < floor(watermark / bucketMs)` has all timestamps strictly `< watermark` and is evicted in amortized O(1).
- **Limits**:
  1. Memory is **O(active devices × readings within the lateness/window horizon)**; an unbounded number of distinct `deviceId`s cannot be bounded without an eviction policy.
  2. A pathological device that sends an unbounded stream of invalid readings (never advancing `newestAcceptedTs` from `-Infinity`) or invalid readings with far-future `ts` forces exact semantics to retain those `seq`s. This design assumes roughly monotonic device clocks and occasional faults.

### Exact vs. Approximate `p95`
Chose **exact nearest-rank `p95`** using integer ceiling division `Math.floor((95 * n + 99) / 100) - 1` (avoiding floating-point drift in `0.95 * n`). Because open windows per device are already bounded by `ceil(L / W) + 1`, storing accepted values per open window keeps streaming memory independent of stream duration, while guaranteeing bit-identical `p95` between `summarize` and `createStream`. The trade-off is O(readings per window) memory instead of O(1); for high-frequency sensors (e.g., kHz rates), swapping in an approximate quantile sketch (t-digest or DDSketch) would cap per-window memory at O(1) at the cost of bounded rank error.

## Assumptions & What Was Skipped

- **Assumptions**: `config.windowMs > 0`, `config.maxLatenessMs >= 0`, `config.validRange.min <= config.validRange.max`, and readings have finite `ts` and `seq`. Resends preserve `ts` as specified.
- **Skipped**: Adding `typescript` as a devDependency for `tsc` typechecking (kept zero dependencies and no install step as in the starter repo; `AGENTS.md` enforces erasable TS conventions).

## What I Would Do Next With More Time

1. **Config & input validation**: Guard against invalid configs (`windowMs <= 0`, inverted `validRange`) and non-finite `ts`/`seq`.
2. **Production stream hardening**: Add an idle-device TTL / max-state cap with observability metrics (drop-reason counters for `duplicate`, `invalid`, `late`, plus forced-eviction alerts) to handle the pathological-device cases above.
3. **High-rate percentile sketch**: Make `p95` pluggable so high-frequency fleets can opt into a bounded-memory t-digest/DDSketch while low-rate fleets keep exact percentiles.
4. **CI typecheck**: Run `tsc --noEmit` in CI alongside `node --test` since Node type-stripping does not typecheck.
