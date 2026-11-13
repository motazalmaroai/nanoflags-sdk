// Module resolution hook for ./rn-env.mjs: `react-native` → ./rn-shim.mjs.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "react-native") return { url: new URL("./rn-shim.mjs", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
