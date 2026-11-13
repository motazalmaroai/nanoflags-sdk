// Device test against the production edge with the public demo browser key:
//
//   flutter test integration_test --dart-define=NANOFLAGS_SDK_KEY=nf_pub_…
//
// Loads the demo flags, toggles `demo-accent` through POST /v1/demo/toggle, asserts the widget
// updates live (pushed over the WebSocket), and restores the original value.
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:nanoflags_example/main.dart';
import 'package:nanoflags_flutter/nanoflags_flutter.dart';

const colors = ['blue', 'orange', 'green'];

Future<Map<String, Object?>> toggle(String flag, Object value) async {
  var attempt = 0;
  while (true) {
    final res = await http.post(Uri.parse('$officialEdgeUrl/v1/demo/toggle'),
        headers: {'Content-Type': 'application/json', 'User-Agent': 'nanoflags-flutter-integration-test/$sdkVersion'},
        body: jsonEncode({'flag': flag, 'value': value}));
    final body = (jsonDecode(res.body.isEmpty ? '{}' : res.body) as Map).cast<String, Object?>();
    // Rate limited (shared public demo): wait as told and retry a few times.
    if (res.statusCode == 429 && attempt++ < 4) {
      await Future<void>.delayed(Duration(milliseconds: ((body['retryAfterMs'] as num?) ?? 5000).toInt() + 500));
      continue;
    }
    return {...body, 'httpStatus': res.statusCode};
  }
}

String? accentText(WidgetTester tester) {
  final f = find.byKey(const ValueKey('accent'));
  if (f.evaluate().isEmpty) return null;
  return (tester.widget<Text>(f).data ?? '').replaceFirst('accent: ', '');
}

Future<bool> pumpUntil(WidgetTester tester, bool Function() condition, {Duration timeout = const Duration(seconds: 20)}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 50));
    if (condition()) return true;
  }
  return condition();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('demo flag updates live after a toggle', (tester) async {
    expect(demoKey, startsWith('nf_pub_'), reason: 'run with --dart-define=NANOFLAGS_SDK_KEY=<public demo key>');
    await tester.pumpWidget(const DemoApp(
      options: NanoFlagsOptions(sdkKey: demoKey, service: 'flutter-integration-test', context: {'key': 'integration-test'}, events: EventsOptions.off()),
    ));

    // The verified configuration arrives and the live socket opens.
    final client = NanoFlagsProvider.read(tester.element(find.byType(DemoScreen)))!;
    expect(await pumpUntil(tester, () => client.revision != null && client.transport == NanoFlagsTransport.live), isTrue,
        reason: 'status ${client.status.name}, transport ${client.transport.name}');
    final original = accentText(tester)!;
    expect(colors, contains(original));
    final next = colors[(colors.indexOf(original) + 1) % colors.length];

    var restored = false;
    addTearDown(() async {
      if (!restored) await toggle('demo-accent', original);
    });

    final sent = DateTime.now();
    final r = await toggle('demo-accent', next);
    expect(r['status'], 'published', reason: jsonEncode(r));
    expect(await pumpUntil(tester, () => accentText(tester) == next), isTrue, reason: 'widget did not update to $next');
    final ms = DateTime.now().difference(sent).inMilliseconds;
    // ignore: avoid_print
    print('toggle sent → widget shows "$next": $ms ms (r${r['revision']}, transport ${client.transport.name})');
    expect(client.transport, NanoFlagsTransport.live);

    final back = await toggle('demo-accent', original);
    restored = true;
    expect(back['status'], anyOf('published', 'unchanged'), reason: jsonEncode(back));
    expect(await pumpUntil(tester, () => accentText(tester) == original), isTrue);

    await tester.pumpWidget(const SizedBox());
  });
}
