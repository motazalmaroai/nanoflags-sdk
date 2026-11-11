"use client";
/**
 * @nanoflags/sdk/react — bindings built on useSyncExternalStore.
 * Components re-render when the bundle or the client status changes; evaluation stays local.
 */
import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import type { ClientStatus, Context, JsonValue, NanoFlagsClient } from "./index.js";

interface ProviderValue {
  client: NanoFlagsClient;
  context: Context;
}

const NanoFlagsContext = createContext<ProviderValue | null>(null);

export interface NanoFlagsProviderProps {
  client: NanoFlagsClient;
  /** Evaluation context shared by every `useFlag` below this provider. */
  context?: Context;
  children?: ReactNode;
}

export function NanoFlagsProvider({ client, context, children }: NanoFlagsProviderProps): ReactElement {
  const serialized = JSON.stringify(context ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the context is compared by value
  const value = useMemo<ProviderValue>(() => ({ client, context: context ?? {} }), [client, serialized]);
  return createElement(NanoFlagsContext.Provider, { value }, children);
}

function useProvider(): ProviderValue {
  const value = useContext(NanoFlagsContext);
  if (!value) throw new Error("useFlag/useFlagsStatus must be used inside <NanoFlagsProvider>.");
  return value;
}

function useVersion(client: NanoFlagsClient): number {
  return useSyncExternalStore(
    client.subscribe,
    () => client.version,
    () => client.version,
  );
}

type Widen<T> = T extends boolean ? boolean : T extends string ? string : T extends number ? number : T;

/**
 * Value of a flag for the provider context (shallow-merged with `ctxOverride`).
 * The accessor is chosen from the type of `fallback`: boolean, string, number, otherwise JSON.
 * A missing flag, a missing bundle or a type mismatch returns `fallback`.
 */
export function useFlag<T extends JsonValue>(key: string, fallback: T, ctxOverride?: Context): Widen<T> {
  const { client, context } = useProvider();
  const version = useVersion(client);
  const override = JSON.stringify(ctxOverride ?? null);
  const fb = typeof fallback === "object" ? JSON.stringify(fallback) : fallback;
  return useMemo(() => {
    const ctx: Context = ctxOverride ? { ...context, ...ctxOverride } : context;
    if (typeof fallback === "boolean") return client.boolean(key, fallback, ctx);
    if (typeof fallback === "string") return client.string(key, fallback, ctx);
    if (typeof fallback === "number") return client.number(key, fallback, ctx);
    return client.json(key, fallback, ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- contexts and fallbacks are compared by value
  }, [client, version, key, fb, context, override]) as Widen<T>;
}

export interface FlagsStatus {
  status: ClientStatus;
  revision: number | null;
  /** True when a bundle is loaded (status "ready" or "stale"). */
  hasBundle: boolean;
}

export function useFlagsStatus(): FlagsStatus {
  const { client } = useProvider();
  const version = useVersion(client);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` changes whenever status/revision do
  return useMemo(() => ({ status: client.status, revision: client.revision, hasBundle: client.status !== "not-ready" }), [client, version]);
}
