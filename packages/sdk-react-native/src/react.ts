/**
 * React bindings for React Native. Built on `@nanoflags/sdk/react` (`useSyncExternalStore`): components re-render when
 * a new revision arrives, the status changes or `identify()` replaces the context. No Suspense: `useNanoFlags()`
 * reports `loading` until the first load attempt (storage + network) has finished, and flags return their fallback
 * until then.
 */
import { createContext, createElement, useCallback, useContext, useMemo, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { NanoFlagsProvider as CoreProvider, useFlag, useFlagsStatus, type FlagsStatus } from "@nanoflags/sdk/react";
import type { ClientStatus, Context, JsonValue, Transport } from "@nanoflags/sdk";
import type { FlagDetail, ReactNativeClient } from "./client.js";
import type { LifecycleState } from "./lifecycle.js";

export { useFlag, useFlagsStatus, type FlagsStatus };

interface ProviderValue {
  client: ReactNativeClient;
  /** Provider-level context, shallow-merged over the client's identified context. */
  context: Context | undefined;
}

const RNContext = createContext<ProviderValue | null>(null);

export interface NanoFlagsProviderProps {
  client: ReactNativeClient;
  /**
   * Optional extra context for every hook below this provider, merged over the client's context (`identify()`).
   * Most apps leave it out and call `identify()` when the user changes.
   */
  context?: Context;
  children?: ReactNode;
}

export function NanoFlagsProvider({ client, context, children }: NanoFlagsProviderProps): ReactElement {
  const serialized = JSON.stringify(context ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the context is compared by value
  const value = useMemo<ProviderValue>(() => ({ client, context }), [client, serialized]);
  return createElement(RNContext.Provider, { value }, createElement(CoreProvider, { client, ...(context ? { context } : {}) }, children));
}

function useProvider(): ProviderValue {
  const value = useContext(RNContext);
  if (!value) throw new Error("NanoFlags hooks must be used inside <NanoFlagsProvider>.");
  return value;
}

function useVersion(client: ReactNativeClient): number {
  return useSyncExternalStore(
    client.subscribe,
    () => client.version,
    () => client.version,
  );
}

/** Boolean flag; `fallback` (default false) while nothing is loaded, for a missing flag or a non-boolean value. */
export function useBoolFlag(key: string, fallback = false, ctxOverride?: Context): boolean {
  return useFlag(key, fallback, ctxOverride);
}

type Widen<T> = T extends boolean ? boolean : T extends string ? string : T extends number ? number : T;

/** Value plus reason / matched rule / revision, typed by `fallback`. */
export function useFlagDetail<T extends JsonValue>(key: string, fallback: T, ctxOverride?: Context): FlagDetail<Widen<T>> {
  const { client, context } = useProvider();
  const version = useVersion(client);
  const fb = typeof fallback === "object" ? JSON.stringify(fallback) : fallback;
  const override = JSON.stringify(ctxOverride ?? null);
  return useMemo(
    () => client.detail(key, fallback, context || ctxOverride ? { ...context, ...ctxOverride } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- contexts and fallbacks are compared by value
    [client, version, key, fb, context, override],
  );
}

/** Every flag's value for the current context (client-exposed flags only, as delivered to client keys). */
export function useAllFlags(ctxOverride?: Context): Record<string, JsonValue> {
  const { client, context } = useProvider();
  const version = useVersion(client);
  const override = JSON.stringify(ctxOverride ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- contexts are compared by value
  return useMemo(() => client.allFlags(context || ctxOverride ? { ...context, ...ctxOverride } : undefined), [client, version, context, override]);
}

export interface NanoFlagsState {
  client: ReactNativeClient;
  /** True until the first load attempt (storage + network) has finished. Render a placeholder or the fallbacks. */
  loading: boolean;
  /** "not-ready" (no bundle), "ready" (current) or "stale" (last known bundle; offline, paused or rejected update). */
  status: ClientStatus;
  revision: number | null;
  /** True when a bundle is loaded (status "ready" or "stale"). */
  hasBundle: boolean;
  transport: Transport;
  lifecycle: LifecycleState;
  /** The client's current context (`identify()`). */
  context: Context;
  /** Replace the evaluation context; every hook re-renders with the new values. Stable across renders. */
  identify: (context: Context) => void;
  /** Revalidate now (e.g. pull-to-refresh). */
  refresh: () => Promise<void>;
}

/** Client, loading state and `identify` for the nearest provider. */
export function useNanoFlags(): NanoFlagsState {
  const { client } = useProvider();
  const version = useVersion(client);
  const identify = useCallback((ctx: Context) => client.identify(ctx), [client]);
  const refresh = useCallback(() => client.refresh(), [client]);
  return useMemo<NanoFlagsState>(
    () => ({
      client,
      loading: !client.settled,
      status: client.status,
      revision: client.revision,
      hasBundle: client.status !== "not-ready",
      transport: client.transport,
      lifecycle: client.lifecycle,
      context: client.context,
      identify,
      refresh,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` changes whenever any of these do
    [client, version, identify, refresh],
  );
}
