/// NanoFlags client SDK for Dart and Flutter.
///
/// Local, synchronous flag evaluation against signed configuration bundles, kept current over a
/// live WebSocket (with SSE and polling fallbacks). Client (`nf_pub_…`) keys only.
///
/// ```dart
/// import 'package:nanoflags/nanoflags.dart';
///
/// final flags = NanoFlagsClient(const NanoFlagsOptions(
///   sdkKey: 'nf_pub_…',
///   context: {'key': 'user-42', 'plan': 'pro'},
/// ));
/// await flags.ready();
/// final enabled = flags.boolVariation('new-checkout', false);
/// ```
library;

export 'src/client.dart' show NanoFlagsClient, WebSocketConnector;
export 'src/engine/engine.dart' show Evaluation, Reasons, TraceStep, engineVersion;
export 'src/keys.dart';
export 'src/store.dart';
export 'src/types.dart';
