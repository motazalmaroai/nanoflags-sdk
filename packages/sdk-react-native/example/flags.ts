/**
 * One NanoFlags client for the whole app, created at module scope (not inside a component).
 *
 * The SDK key is a browser/client key (nf_pub_…): it only receives flags marked "client-exposed". Put it in `.env`:
 *   EXPO_PUBLIC_NANOFLAGS_SDK_KEY=nf_pub_…
 * The public live-demo key from https://nanoflags.io/docs works here too (flags `demo-new-checkout`, `demo-accent`).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { asyncStorage, createClient } from "@nanoflags/react-native";

export const flags = createClient({
  sdkKey: process.env.EXPO_PUBLIC_NANOFLAGS_SDK_KEY ?? "nf_pub_missing",
  service: "nanoflags-expo-example",
  // Offline-first: the last verified bundle is kept on the device and verified again at the next launch.
  storage: asyncStorage(AsyncStorage),
  // Optional: pause while offline, no live socket on metered connections (data saver).
  netInfo: NetInfo,
  // The user is anonymous until they sign in; `identify()` replaces this later.
  context: { key: "anonymous-device", platform: "expo" },
});

flags.on("error", (e) => {
  if (__DEV__) console.warn(`[nanoflags] ${e.message}`);
});
