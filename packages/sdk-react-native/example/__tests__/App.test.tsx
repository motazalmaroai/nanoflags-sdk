/**
 * Jest (jest-expo preset, React Native test renderer) for the example app: the real @nanoflags/react-native package,
 * with a client that starts from a bundled configuration and never touches the network.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { OpenFeature } from "@openfeature/react-sdk";
import App from "../App";

jest.mock("../flags", () => {
  const { createClient } = require("@nanoflags/react-native");
  const bundle = {
    schema: 1,
    engine: 1,
    project: "demo",
    environment: "jest",
    revision: 7,
    segments: {},
    flags: {
      "demo-accent": { type: "string", enabled: true, clientExposed: true, default: "orange", off: "blue", rules: [] },
      "demo-new-checkout": {
        type: "boolean",
        enabled: true,
        clientExposed: true,
        default: false,
        off: false,
        rules: [{ id: "beta-users", match: "all", conditions: [{ attribute: "plan", op: "eq", value: "beta" }], serve: { type: "fixed", value: true } }],
      },
    },
  };
  return {
    flags: createClient({
      sdkKey: "nf_pub_jest",
      baseUrl: "https://edge.invalid",
      bootstrap: bundle,
      storage: false,
      appState: null,
      streaming: false,
      pollIntervalMs: 0,
      events: false,
      context: { key: "anonymous-device", platform: "expo" },
      fetch: () => Promise.reject(new TypeError("offline")),
    }),
  };
});

afterAll(async () => {
  await OpenFeature.close();
  require("../flags").flags.close();
});

test("shows the flag values once loaded (no Suspense)", async () => {
  await render(<App />);
  expect(await screen.findByText("demo-accent = orange")).toBeTruthy();
  expect(screen.getByTestId("reason")).toHaveTextContent("reason default");
  expect(screen.getByTestId("checkout")).toHaveTextContent("Classic checkout");
  // Bootstrap bundle in use; the (mocked) network is unreachable, so it is not known to be current.
  expect(screen.getByTestId("status")).toHaveTextContent(/status stale · r7 · poll/);
});

test("identify() re-renders with the new context, locally", async () => {
  await render(<App />);
  await screen.findByText("demo-accent = orange");
  await fireEvent.press(screen.getByTestId("sign-in"));
  expect(screen.getByTestId("checkout")).toHaveTextContent("New checkout");
  expect(screen.getByTestId("reason")).toHaveTextContent("reason default");
  expect(screen.getByTestId("context")).toHaveTextContent(/user-42/);
  await fireEvent.press(screen.getByTestId("sign-out"));
  expect(screen.getByTestId("checkout")).toHaveTextContent("Classic checkout");
});

test("OpenFeature hooks see the same configuration", async () => {
  await render(<App />);
  await screen.findByText("demo-accent = orange");
  await act(async () => {
    await OpenFeature.setContext({ targetingKey: "user-42", plan: "beta" });
  });
  expect(await screen.findByText("OpenFeature says demo-new-checkout = true")).toBeTruthy();
  // OpenFeature's context became the client's context: the NanoFlags hooks follow.
  expect(screen.getByTestId("checkout")).toHaveTextContent("New checkout");
});
