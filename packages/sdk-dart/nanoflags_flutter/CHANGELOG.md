# Changelog

## 0.1.1

- Allows `nanoflags` 0.2.x (shadow evaluation of drafts). The provider's lifecycle handling already sends pending
  shadow counters when the app goes to the background (`pause()`). Pass `serviceVersion` (for example from
  `package_info_plus`) in `NanoFlagsOptions` to label reports with your app's version. Not published yet.

## 0.1.0

First release: `NanoFlagsProvider` (InheritedWidget, rebuilds on configuration / status / context
changes), `FlagBuilder` and `FlagDetailBuilder`, app lifecycle handling (pause in the background,
resume and revalidate in the foreground), `SharedPreferencesStore` persistence, example app with a
device integration test against the public live demo.
