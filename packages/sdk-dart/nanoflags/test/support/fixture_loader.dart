// Hybrid isolate (runs on the VM) that hands the parity fixture text to tests compiled for the web.
import 'dart:io';

import 'package:stream_channel/stream_channel.dart';

const _paths = {
  'parity': ['../../engine/fixtures/parity.json', '../../../packages/engine/fixtures/parity.json'],
  'extra': ['../../sdk-go/internal/testdata/extra.json', '../../../go/internal/testdata/extra.json'],
};

void hybridMain(StreamChannel<Object?> channel, Object? message) {
  final candidates = _paths[message] ?? const <String>[];
  for (final p in candidates) {
    final f = File(p);
    if (f.existsSync()) {
      channel.sink.add(f.readAsStringSync());
      return;
    }
  }
  channel.sink.add(null);
}
