/**
 * Test double for the parts of `react-native` the SDK touches: `AppState` (current state + "change" listeners).
 * Tests drive it with `AppState.set("background" | "active" | "inactive")`.
 */
type Listener = (state: string) => void;

const listeners = new Set<Listener>();

export const AppState = {
  currentState: "active" as string,
  addEventListener(type: "change", listener: Listener) {
    if (type !== "change") return { remove() {} };
    listeners.add(listener);
    return { remove: () => void listeners.delete(listener) };
  },
  /** Test helper: switch state and notify listeners. */
  set(state: string) {
    AppState.currentState = state;
    for (const l of [...listeners]) l(state);
  },
  /** Test helper: forget listeners, back to "active". */
  reset() {
    listeners.clear();
    AppState.currentState = "active";
  },
  get listenerCount() {
    return listeners.size;
  },
};

export const Platform = { OS: "ios" as const, select: <T>(o: { ios?: T; default?: T }) => o.ios ?? o.default };
