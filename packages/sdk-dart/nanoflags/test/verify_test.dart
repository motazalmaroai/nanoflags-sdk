// Signature verification: the real signed answer of the production edge (offline interop vector),
// tampering, key handling, and the raw-bundle extraction the canonical hash depends on.
@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:nanoflags/engine.dart';
import 'package:nanoflags/nanoflags.dart';
import 'package:nanoflags/verify.dart';
import 'package:test/test.dart';

void main() {
  final vector = jsonDecode(File('test/fixtures/signed-demo-response.json').readAsStringSync()) as Map<String, Object?>;
  final headers = (vector['headers'] as Map).cast<String, String>();
  final body = vector['body'] as String;

  SignatureInfo infoFor(String text) {
    final parsed = jsonDecode(text) as Map;
    return SignatureInfo(
      signature: headers['x-nanoflags-signature']!,
      kid: headers['x-nanoflags-key-id'],
      environmentId: headers['x-nanoflags-environment-id']!,
      revision: parsed['revision'] as int,
      checksum: parsed['checksum'] as String,
    );
  }

  test('the production signature verifies with the embedded k1 key', () async {
    final raw = rawMember(body, 'bundle')!;
    expect(raw, startsWith('{"flags":'));
    expect(await verifyBundleText(importPublicKeys(officialSigningKeys), infoFor(body), raw), isTrue);
  });

  test('JSON.stringify of the parsed bundle reproduces the signed text (the raw text is hashed regardless)', () {
    final raw = rawMember(body, 'bundle')!;
    final reencoded = jsonEncode((jsonDecode(body) as Map)['bundle']);
    // Same content; the raw text is what is verified, so key order or number formatting can never matter.
    expect(jsonDecode(reencoded), jsonDecode(raw));
    expect(jsStringify(jsonDecode(raw)), raw, reason: 'JSON.stringify of the parsed bundle reproduces the stored text');
  });

  test('a tampered bundle, revision, checksum, environment or kid does not verify', () async {
    final keys = importPublicKeys(officialSigningKeys);
    final raw = rawMember(body, 'bundle')!;
    final info = infoFor(body);
    expect(await verifyBundleText(keys, info, raw.replaceFirst('"default":false', '"default":true')), isFalse);
    expect(await verifyBundleText(keys, SignatureInfo(signature: info.signature, kid: info.kid, environmentId: info.environmentId, revision: info.revision + 1, checksum: info.checksum), raw), isFalse);
    expect(await verifyBundleText(keys, SignatureInfo(signature: info.signature, kid: info.kid, environmentId: info.environmentId, revision: info.revision, checksum: '0' * 32), raw), isFalse);
    expect(await verifyBundleText(keys, SignatureInfo(signature: info.signature, kid: info.kid, environmentId: 'other', revision: info.revision, checksum: info.checksum), raw), isFalse);
    // an unknown kid is not "any key"
    expect(await verifyBundleText(keys, SignatureInfo(signature: info.signature, kid: 'k9', environmentId: info.environmentId, revision: info.revision, checksum: info.checksum), raw), isFalse);
    // malformed signatures
    expect(await verifyBundleText(keys, SignatureInfo(signature: '${info.signature}x', kid: info.kid, environmentId: info.environmentId, revision: info.revision, checksum: info.checksum), raw), isFalse);
    expect(await verifyBundleText(keys, SignatureInfo(signature: 'AAAA', kid: info.kid, environmentId: info.environmentId, revision: info.revision, checksum: info.checksum), raw), isFalse);
  });

  test('private JWKs and malformed keys are never imported', () {
    final x = officialSigningKeys.first['x']!;
    expect(isPublicEd25519Jwk({'kty': 'OKP', 'crv': 'Ed25519', 'x': x}), isTrue);
    // a JWK carrying the private scalar is refused outright
    expect(isPublicEd25519Jwk({'kty': 'OKP', 'crv': 'Ed25519', 'x': x, 'd': x}), isFalse);
    expect(importPublicKeys([
      {'kty': 'OKP', 'crv': 'Ed25519', 'x': x, 'd': x},
      {'kty': 'EC', 'crv': 'P-256', 'x': x},
      {'kty': 'OKP', 'crv': 'Ed25519', 'x': 'short'},
    ]), isEmpty);
  });

  test('rawMember: last member wins, nested and escaped text, malformed input', () {
    expect(rawMember('{"bundle":{"a":"}"},"x":1}', 'bundle'), '{"a":"}"}');
    expect(rawMember('{"bundle":1,"bundle":[1,{"b":"\\"]"}]}', 'bundle'), '[1,{"b":"\\"]"}]');
    expect(rawMember(' { "revision" : 3 , "bundle" : {"k":"ü🙂"} } ', 'bundle'), '{"k":"ü🙂"}');
    expect(rawMember('{"bun\\u0064le":{"x":1}}', 'bundle'), '{"x":1}');
    expect(rawMember('[1]', 'bundle'), isNull);
    expect(rawMember('{"bundle":', 'bundle'), isNull);
    expect(rawMember('{"other":1}', 'bundle'), isNull);
  });

  test('canonical string and sha256', () {
    expect(canonicalString('env', 7, 'abc', 'ff'), 'nanoflags-bundle-v1\nenv\n7\nabc\nff');
    expect(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  group('JavaScript semantics', () {
    test('Number::toString', () {
      final cases = <num, String>{
        0: '0', -0.0: '0', 1: '1', 1.0: '1', -1.5: '-1.5', 100: '100', 0.1: '0.1', 1e21: '1e+21', 1e20: '100000000000000000000',
        123456789012345680000.0: '123456789012345680000', 1e-6: '0.000001', 1e-7: '1e-7', 1.5e-7: '1.5e-7', 2.5e300: '2.5e+300',
        0.000123: '0.000123', 5e-324: '5e-324', 1.7976931348623157e308: '1.7976931348623157e+308', 33.33: '33.33', 9007199254740993: '9007199254740992',
      };
      cases.forEach((v, s) => expect(jsNumberToString(v), s, reason: '$v'));
      expect(jsNumberToString(double.nan), 'NaN');
      expect(jsNumberToString(double.negativeInfinity), '-Infinity');
    });

    test('JSON.stringify key order, escapes and numbers', () {
      final v = jsonDecode('{"b":1,"10":2,"a":[1.0,-0.0,1e400,"\\u0001\\ud800",null],"2":true,"01":3}');
      expect(jsStringify(v), '{"2":true,"10":2,"b":1,"a":[1,0,null,"\\u0001\\ud800",null],"01":3}');
      expect(jsStringify(undefined), isNull);
      expect(jsStringify('🙂'), '"🙂"');
    });

    test('String()', () {
      expect(jsString([1, null, 'a', [2, 3], true]), '1,,a,2,3,true');
      expect(jsString({'a': 1}), '[object Object]');
      expect(jsString(undefined), 'undefined');
    });

    test('murmur3 hashes the UTF-8 bytes of NFC strings', () {
      expect(murmur3('é'), murmur3('é'));
      expect(murmur3('Å'), murmur3('Å'));
      expect(murmur3('🙂'), isNot(murmur3('\ud83d')));
      expect(murmur3('\ud83d'), murmur3('�'), reason: 'a lone surrogate encodes as U+FFFD, like TextEncoder');
    });
  });
}
