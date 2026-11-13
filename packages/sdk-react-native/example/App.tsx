import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, Button, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { OpenFeature, OpenFeatureProvider, useBooleanFlagValue } from "@openfeature/react-sdk";
import { NanoFlagsProvider, useBoolFlag, useFlag, useFlagDetail, useNanoFlags } from "@nanoflags/react-native";
import { NanoFlagsReactNativeProvider } from "@nanoflags/react-native/openfeature";
import { flags } from "./flags";

const ACCENTS: Record<string, string> = { blue: "#2563eb", orange: "#ea580c", green: "#16a34a" };

// Optional: the same flags through OpenFeature. OpenFeature's context becomes the NanoFlags client's context.
void OpenFeature.setProviderAndWait(new NanoFlagsReactNativeProvider({ client: flags }));

export default function App() {
  return (
    <NanoFlagsProvider client={flags}>
      <OpenFeatureProvider>
        <Home />
        <StatusBar style="auto" />
      </OpenFeatureProvider>
    </NanoFlagsProvider>
  );
}

function Home() {
  const { loading, status, revision, transport, lifecycle, context, identify, refresh } = useNanoFlags();
  const newCheckout = useBoolFlag("demo-new-checkout");
  const accent = useFlag("demo-accent", "blue");
  const detail = useFlagDetail("demo-accent", "blue");
  const viaOpenFeature = useBooleanFlagValue("demo-new-checkout", false);

  useEffect(() => {
    // E.g. after restoring a session: identify the user. Local and synchronous, no request.
    // identify({ key: user.id, plan: user.plan });
  }, []);

  if (loading) {
    // Suspense-free: the first load attempt (device storage + network) is still running.
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text testID="loading">Loading flags…</Text>
      </View>
    );
  }

  const color = ACCENTS[accent] ?? ACCENTS.blue;
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>NanoFlags · React Native</Text>
      <Text testID="status">
        status {status} · r{revision ?? "–"} · {transport}
        {lifecycle.paused ? " · paused" : ""}
        {lifecycle.metered ? " · data saver" : ""}
      </Text>

      <View style={[styles.card, { borderColor: color }]}>
        <Text testID="accent" style={[styles.accent, { color }]}>demo-accent = {accent}</Text>
        <Text testID="reason" style={styles.small}>
          reason {detail.reason}
          {detail.ruleId ? ` · rule ${detail.ruleId}` : ""}
        </Text>
      </View>

      <Pressable style={[styles.button, { backgroundColor: color }]}>
        <Text testID="checkout" style={styles.buttonText}>{newCheckout ? "New checkout" : "Classic checkout"}</Text>
      </Pressable>
      <Text testID="openfeature" style={styles.small}>OpenFeature says demo-new-checkout = {String(viaOpenFeature)}</Text>

      <Text testID="context" style={styles.small}>context: {JSON.stringify(context)}</Text>
      <View style={styles.row}>
        <Button testID="sign-in" title="Sign in as beta user" onPress={() => identify({ key: "user-42", plan: "beta", platform: "expo" })} />
        <Button testID="sign-out" title="Sign out" onPress={() => identify({ key: "anonymous-device", platform: "expo" })} />
      </View>
      <Button testID="refresh" title="Refresh" onPress={() => void refresh()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  container: { padding: 24, gap: 16, paddingTop: 72 },
  title: { fontSize: 22, fontWeight: "600" },
  card: { borderWidth: 2, borderRadius: 12, padding: 16, gap: 4 },
  accent: { fontSize: 18, fontWeight: "600" },
  small: { color: "#555" },
  button: { borderRadius: 10, padding: 14, alignItems: "center" },
  buttonText: { color: "white", fontWeight: "600" },
  row: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
});
