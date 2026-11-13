/// The NanoFlags evaluation engine on its own: a Dart port of `@nanoflags/engine` with identical
/// results (asserted by the shared parity fixtures). Most applications use
/// `package:nanoflags/nanoflags.dart` instead.
library;

export 'src/engine/engine.dart';
export 'src/engine/js.dart' show isUndefined, jsNumberToString, jsString, jsStringify, typeName, undefined;
