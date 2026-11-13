/**
 * @nanoflags/react-native — NanoFlags for React Native and Expo.
 *
 * Flags are evaluated locally and synchronously by the same engine and client core as `@nanoflags/sdk` (compiled into
 * this package). Bundles are signature-verified (pure-JS Ed25519, Hermes has no WebCrypto), persisted for offline
 * starts and verified again when loaded; updates arrive over the live WebSocket (then SSE, then ETag polling), which
 * is paused while the app is in the background.
 */
export { createClient, DEFAULT_USER_AGENT, SDK_VERSION, type FlagDetail, type ReactNativeClient, type ReactNativeClientOptions } from "./client.js";
export { asyncStorage, memoryStorage, type AsyncStorageLike, type StorageAdapter } from "./storage.js";
export { nobleCrypto } from "./crypto.js";
export type { AppStateLike, LifecycleState, NetInfoLike, NetInfoStateLike } from "./lifecycle.js";
export { xhrStreamOpener, type ReactNativeWebSocketConstructor, type XhrConstructor, type XhrLike } from "./transport.js";
export {
  NanoFlagsProvider,
  useAllFlags,
  useBoolFlag,
  useFlag,
  useFlagDetail,
  useFlagsStatus,
  useNanoFlags,
  type FlagsStatus,
  type NanoFlagsProviderProps,
  type NanoFlagsState,
} from "./react.js";
export {
  CLOSE_ENVIRONMENT_DELETED,
  NanoFlagsError,
  OFFICIAL_EDGE_URL,
  OFFICIAL_SIGNING_KEYS,
  SUPPORTED_ENGINE_VERSION,
  type Bundle,
  type ClientStatus,
  type Context,
  type Evaluation,
  type EventsOptions,
  type JsonValue,
  type NanoFlagsClient,
  type Reason,
  type SignatureCrypto,
  type Transport,
  type UpdateEvent,
  type VerifyOptions,
} from "@nanoflags/sdk";
