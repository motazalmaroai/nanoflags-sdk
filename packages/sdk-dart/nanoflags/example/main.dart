// Quickstart: evaluate flags from the public NanoFlags demo.
//
//   NANOFLAGS_SDK_KEY=nf_pub_… dart run example/main.dart
import 'dart:async';
import 'dart:io';

import 'package:nanoflags/nanoflags.dart';

Future<void> main() async {
  final key = Platform.environment['NANOFLAGS_SDK_KEY'];
  if (key == null || key.isEmpty) {
    stderr.writeln('Set NANOFLAGS_SDK_KEY to a client key (nf_pub_…).');
    exitCode = 2;
    return;
  }
  final flags = NanoFlagsClient(NanoFlagsOptions(
    sdkKey: key,
    service: 'dart-quickstart',
    context: const {'key': 'user-42', 'plan': 'pro'},
  ));
  flags.errors.listen((e) => stderr.writeln('nanoflags: $e'));
  await flags.ready(timeout: const Duration(seconds: 10));

  print('status ${flags.status.name}, revision ${flags.revision}');
  print('demo-new-checkout = ${flags.boolVariation('demo-new-checkout', false)}');
  print('demo-accent       = ${flags.stringVariation('demo-accent', 'blue')}');
  print('all flags         = ${flags.allFlags()}');

  // Changes are pushed over the live WebSocket; listen for 20 seconds.
  final sub = flags.updates.listen((e) => print('update: $e → accent ${flags.stringVariation('demo-accent', 'blue')}'));
  await Future<void>.delayed(const Duration(seconds: 20));
  await sub.cancel();
  await flags.close();
}
