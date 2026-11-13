import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nanoflags_flutter/nanoflags_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

Map<String, Object?> bundle(int revision, {bool checkout = true, String accent = 'blue'}) => {
      'schema': 1,
      'project': 'p',
      'environment': 'e',
      'revision': revision,
      'segments': <String, Object?>{},
      'flags': {
        'checkout': {'type': 'boolean', 'enabled': true, 'rules': <Object?>[], 'default': checkout, 'off': false, 'clientExposed': true},
        'accent': {
          'type': 'string',
          'enabled': true,
          'rules': [
            {
              'id': 'vip',
              'match': 'all',
              'conditions': [
                {'attribute': 'plan', 'op': 'eq', 'value': 'vip'}
              ],
              'serve': {'type': 'fixed', 'value': 'gold'}
            }
          ],
          'default': accent,
          'off': 'grey',
          'clientExposed': true
        },
        'limit': {'type': 'number', 'enabled': true, 'rules': <Object?>[], 'default': 3, 'off': 0, 'clientExposed': true},
      },
    };

/// A client that never touches the network: bootstrap bundle, no streaming, no polling, no telemetry.
NanoFlagsClient offlineClient({Map<String, Object?> context = const {'key': 'u1'}}) => NanoFlagsClient(
      NanoFlagsOptions(
        sdkKey: 'nf_pub_widget-test',
        baseUrl: 'https://edge.invalid',
        context: context,
        bootstrap: bundle(1),
        streaming: false,
        pollInterval: Duration.zero,
        events: const EventsOptions.off(),
        verify: const VerifyOptions.off(),
      ),
      httpClient: MockClient((_) async => http.Response('', 503)),
    );

void main() {
  testWidgets('FlagBuilder renders flag values and rebuilds on context changes', (tester) async {
    final client = offlineClient();
    await tester.pumpWidget(Directionality(
      textDirection: TextDirection.ltr,
      child: NanoFlagsProvider(
        client: client,
        child: Column(children: [
          FlagBuilder<bool>(flagKey: 'checkout', fallback: false, builder: (_, v) => Text('checkout:$v')),
          FlagBuilder<String>(flagKey: 'accent', fallback: 'none', builder: (_, v) => Text('accent:$v')),
          FlagBuilder<int>(flagKey: 'limit', fallback: 0, builder: (_, v) => Text('limit:$v')),
          FlagBuilder<String>(flagKey: 'missing', fallback: 'fb', builder: (_, v) => Text('missing:$v')),
          FlagBuilder<int>(flagKey: 'accent', fallback: -1, builder: (_, v) => Text('wrongtype:$v')),
          FlagDetailBuilder<String>(flagKey: 'accent', fallback: 'none', builder: (_, d) => Text('reason:${d.reason}')),
        ]),
      ),
    ));
    expect(find.text('checkout:true'), findsOneWidget);
    expect(find.text('accent:blue'), findsOneWidget);
    expect(find.text('limit:3'), findsOneWidget);
    expect(find.text('missing:fb'), findsOneWidget);
    expect(find.text('wrongtype:-1'), findsOneWidget);
    expect(find.text('reason:default'), findsOneWidget);

    client.identify('u2', {'plan': 'vip'});
    await tester.pump(); // the change notification is delivered asynchronously…
    await tester.pump(); // …and the provider rebuilds its dependents on the next frame
    expect(find.text('accent:gold'), findsOneWidget);
    expect(find.text('reason:rule_match'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await client.close();
  });

  testWidgets('lifecycle: background pauses the client, foreground resumes it', (tester) async {
    final client = offlineClient();
    await tester.pumpWidget(NanoFlagsProvider(client: client, child: const SizedBox()));
    expect(client.isPaused, isFalse);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    expect(client.isPaused, isFalse, reason: 'inactive is transient');
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    expect(client.isPaused, isTrue);
    expect(client.transport, NanoFlagsTransport.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    expect(client.isPaused, isFalse);
    await tester.pumpWidget(const SizedBox());
    await client.close();
  });

  testWidgets('NanoFlagsProvider.of without a provider explains the fix', (tester) async {
    await tester.pumpWidget(Builder(builder: (context) {
      NanoFlagsProvider.of(context);
      return const SizedBox();
    }));
    expect(tester.takeException(), isA<FlutterError>());
  });

  test('SharedPreferencesStore round-trips and isolates entries', () async {
    SharedPreferencesAsyncPlatform.instance = InMemorySharedPreferencesAsync.empty();
    final store = SharedPreferencesStore();
    expect(await store.read('abc'), isNull);
    await store.write('abc', jsonEncode({'v': 1}));
    expect(jsonDecode((await store.read('abc'))!), {'v': 1});
    expect(await SharedPreferencesAsync().getString('nanoflags.abc'), isNotNull);
    expect(await store.read('other'), isNull);
  });

  test('a stored bundle is restored on the next start (offline-first)', () async {
    SharedPreferencesAsyncPlatform.instance = InMemorySharedPreferencesAsync.empty();
    final store = SharedPreferencesStore();
    final options = NanoFlagsOptions(
      sdkKey: 'nf_pub_widget-test',
      baseUrl: 'https://edge.invalid',
      streaming: false,
      pollInterval: Duration.zero,
      events: const EventsOptions.off(),
      verify: const VerifyOptions.off(),
      store: store,
    );
    // First run: the edge answers once (unsigned; verification is off for this test edge).
    final first = NanoFlagsClient(options,
        httpClient: MockClient((req) async => http.Response(jsonEncode({'revision': 7, 'checksum': 'c7', 'bundle': bundle(7, accent: 'orange')}), 200, headers: {'etag': '"c7-client"'})));
    await first.ready();
    expect(first.stringVariation('accent', 'none'), 'orange');
    await first.close();
    // Second run, offline: starts from the stored copy.
    final second = NanoFlagsClient(options, httpClient: MockClient((_) async => throw http.ClientException('offline')));
    await second.ready();
    expect(second.revision, 7);
    expect(second.status, NanoFlagsStatus.stale);
    expect(second.stringVariation('accent', 'none'), 'orange');
    await second.close();
  });
}
