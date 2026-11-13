// `react-native` for ./rn-env.mjs: AppState as React Native exposes it, plus `AppState.set(state)` to script it.
const listeners = new Set();

export const AppState = {
  currentState: "active",
  addEventListener(type, listener) {
    if (type === "change") listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  },
  set(state) {
    AppState.currentState = state;
    for (const l of [...listeners]) l(state);
  },
};

export const Platform = { OS: "ios" };
export default { AppState, Platform };
