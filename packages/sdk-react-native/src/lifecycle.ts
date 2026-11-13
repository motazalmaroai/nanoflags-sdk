/**
 * App lifecycle and connectivity → the core client's `LifecycleControl`.
 *
 *   app in the background (AppState "background")   pause: live socket closed, no polling, telemetry flushed once
 *   back in the foreground                          resume: conditional revalidation now, then the live socket again
 *   offline (NetInfo isConnected / isInternetReachable false)   pause; back online → resume
 *   metered connection (NetInfo details.isConnectionExpensive)  with `dataSaver`: no live socket, ETag polling only
 *
 * iOS reports "inactive" for transient interruptions (app switcher, incoming call); it does not pause.
 */
import type { LifecycleControl } from "@nanoflags/sdk";

/** The part of React Native's `AppState` the SDK uses. */
export interface AppStateLike {
  readonly currentState: string | null | undefined;
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void } | undefined;
}

/** The part of a `@react-native-community/netinfo` state the SDK reads. */
export interface NetInfoStateLike {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
  details?: { isConnectionExpensive?: boolean } | null;
}

/** The part of `@react-native-community/netinfo`'s default export the SDK uses (optional peer dependency). */
export interface NetInfoLike {
  addEventListener(listener: (state: NetInfoStateLike) => void): () => void;
}

export interface LifecycleState {
  /** The app is in the background (and `pauseInBackground` is on, or not). */
  background: boolean;
  /** NetInfo reports no connection. Always false without NetInfo. */
  offline: boolean;
  /** NetInfo reports a metered (expensive) connection. Always false without NetInfo. */
  metered: boolean;
  /** Background network activity is paused (background with `pauseInBackground`, or offline). */
  paused: boolean;
  /** The live socket / SSE are allowed (false on a metered connection with `dataSaver`). */
  realtime: boolean;
}

export interface LifecycleOptions {
  appState?: AppStateLike | null;
  netInfo?: NetInfoLike | null;
  pauseInBackground: boolean;
  dataSaver: boolean;
  onChange(state: LifecycleState): void;
}

/** Wires AppState / NetInfo to `control`. Returns the cleanup. Never throws. */
export function attachLifecycle(control: LifecycleControl, options: LifecycleOptions): () => void {
  const state: LifecycleState = { background: false, offline: false, metered: false, paused: false, realtime: true };
  const apply = () => {
    const realtime = !(options.dataSaver && state.metered);
    const paused = (options.pauseInBackground && state.background) || state.offline;
    // Realtime first, so a resume does not open a socket that is closed again right away.
    control.setRealtime(realtime);
    if (paused) control.pause();
    else control.resume();
    state.paused = paused;
    state.realtime = realtime;
    try {
      options.onChange({ ...state });
    } catch {
      /* ignore */
    }
  };
  const subscriptions: Array<() => void> = [];
  try {
    const appState = options.appState;
    if (appState) {
      state.background = appState.currentState === "background";
      const sub = appState.addEventListener("change", (next) => {
        const background = next === "background";
        // "inactive" (iOS) and unknown states keep the current mode; only "active" ends a background period.
        if (!background && next !== "active") return;
        if (background === state.background) return;
        state.background = background;
        apply();
      });
      if (sub && typeof sub.remove === "function") subscriptions.push(() => sub.remove());
    }
  } catch {
    /* AppState unavailable (tests, non-RN hosts): behave as always in the foreground */
  }
  try {
    const netInfo = options.netInfo;
    if (netInfo) {
      const off = netInfo.addEventListener((s) => {
        if (!s) return;
        const offline = s.isConnected === false || s.isInternetReachable === false;
        const metered = s.details?.isConnectionExpensive === true;
        if (offline === state.offline && metered === state.metered) return;
        state.offline = offline;
        state.metered = metered;
        apply();
      });
      if (typeof off === "function") subscriptions.push(off);
    }
  } catch {
    /* NetInfo not linked: no connectivity information */
  }
  // Initial state (e.g. started by a background task): paused before the first request.
  if (state.background && options.pauseInBackground) apply();
  else
    try {
      options.onChange({ ...state });
    } catch {
      /* ignore */
    }
  return () => {
    for (const off of subscriptions.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
  };
}
