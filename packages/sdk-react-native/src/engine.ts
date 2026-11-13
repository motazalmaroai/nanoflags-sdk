/**
 * `@nanoflags/react-native/engine` — the evaluation engine the client runs, for tooling and tests (the same code every
 * NanoFlags SDK ships; the parity fixtures check it). Apps normally use the client instead.
 */
export { ENGINE_VERSION, bucketOf, clientBundle, evaluate, murmur3, supportsEngine } from "@nanoflags/engine";
export type { Bundle, Condition, Context, Evaluation, FlagConfig, FlagType, JsonValue, Reason, Rule, Segment, Serve, TraceStep } from "@nanoflags/engine";
