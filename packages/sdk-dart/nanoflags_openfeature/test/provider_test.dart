import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nanoflags/nanoflags.dart';
import 'package:nanoflags_openfeature/nanoflags_openfeature.dart';
import 'package:openfeature_dart_client_sdk/openfeature_dart_client_sdk.dart';
import 'package:test/test.dart';

Map<String, Object?> bundle() => {
      'schema': 1,
      'project': 'p',
      'environment': 'e',
      'revision': 9,
      'segments': <String, Object?>{},
      'flags': {
        'checkout': {'type': 'boolean', 'enabled': true, 'rules': <Object?>[], 'default': true, 'off': false, 'clientExposed': true},
        'disabled': {'type': 'boolean', 'enabled': false, 'rules': <Object?>[], 'default': true, 'off': false, 'clientExposed': true},
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
            },
            {
              'id': 'half',
              'match': 'all',
              'conditions': <Object?>[],
              'serve': {'type': 'rollout', 'percentage': 100, 'value': 'green', 'otherwise': 'blue'}
            }
          ],
          'default': 'blue',
          'off': 'grey',
          'clientExposed': true
        },
        'limit': {'type': 'number', 'enabled': true, 'rules': <Object?>[], 'default': 3, 'off': 0, 'clientExposed': true},
        'ratio': {'type': 'number', 'enabled': true, 'rules': <Object?>[], 'default': 0.5, 'off': 0, 'clientExposed': true},
        'config': {'type': 'json', 'enabled': true, 'rules': <Object?>[], 'default': {'a': 1}, 'off': null, 'clientExposed': true},
      },
    };

void main() {
  late NanoFlagsClient nf;
  late OpenFeatureAPI api;

  setUp(() async {
    nf = NanoFlagsClient(
      NanoFlagsOptions(
        sdkKey: 'nf_pub_openfeature-test',
        baseUrl: 'https://edge.invalid',
        bootstrap: bundle(),
        streaming: false,
        pollInterval: Duration.zero,
        events: const EventsOptions.off(),
        verify: const VerifyOptions.off(),
      ),
      httpClient: MockClient((_) async => http.Response('', 503)),
    );
    api = OpenFeatureAPI.instance;
    await api.setProviderAndWait(NanoFlagsOpenFeatureProvider.withClient(nf, closeClient: true));
  });

  tearDown(() => api.shutdown());

  test('typed values, reasons, variants and metadata', () async {
    await api.setEvaluationContextAndWait(EvaluationContext(targetingKey: 'user-1'));
    final c = api.getClient();
    expect(c.getBooleanValue('checkout', false), isTrue);
    expect(c.getIntegerValue('limit', 0), 3);
    expect(c.getDoubleValue('ratio', 0), 0.5);
    expect(c.getStructureValue('config', const {}), {'a': 1});
    final off = c.getBooleanDetails('disabled', true);
    expect((off.value, off.reason, off.variant), (false, 'DISABLED', 'off'));
    final split = c.getStringDetails('accent', 'none');
    expect((split.value, split.reason, split.variant), ('green', 'SPLIT', 'half'));
    expect(split.flagMetadata['revision'], 9);
    final def = c.getBooleanDetails('checkout', false);
    expect((def.reason, def.variant), ('DEFAULT', 'default'));
  });

  test('context changes are applied locally (targeting key → key)', () async {
    await api.setEvaluationContextAndWait(EvaluationContext(targetingKey: 'user-2', attributes: {'plan': 'vip'}));
    final d = api.getClient().getStringDetails('accent', 'none');
    expect((d.value, d.reason, d.variant), ('gold', 'TARGETING_MATCH', 'vip'));
    expect(nf.context['key'], 'user-2');
  });

  test('errors: missing flag and type mismatch', () {
    final c = api.getClient();
    final missing = c.getBooleanDetails('nope', true);
    expect((missing.value, missing.errorCode), (true, ErrorCode.flagNotFound));
    final mismatch = c.getIntegerDetails('accent', 7);
    expect((mismatch.value, mismatch.errorCode), (7, ErrorCode.typeMismatch));
    final fraction = c.getIntegerDetails('ratio', 1);
    expect(fraction.errorCode, ErrorCode.typeMismatch);
  });
}
