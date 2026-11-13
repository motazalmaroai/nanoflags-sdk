// Resolve Expo's lazily installed globals while the test environment is active.
for (const name of ["TextDecoderStream", "TextEncoderStream", "URL", "URLSearchParams", "DOMException", "__ExpoImportMetaRegistry", "structuredClone", "fetch"]) {
  try {
    void globalThis[name];
  } catch {}
}
