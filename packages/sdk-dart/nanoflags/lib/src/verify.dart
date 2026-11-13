/// Bundle signature verification (Ed25519 over a canonical string).
///
///     canonical = "nanoflags-bundle-v1\n<environment_id>\n<revision>\n<checksum>\n<sha256 hex of the bundle JSON text>"
///
/// The bundle text is the exact text the edge signed: the raw bytes between `"bundle":` and the
/// final `}` of a `/v1/bundle` answer (never a re-serialisation), or the `bundle` string of a live
/// `rev` / `hello` message. Only PUBLIC keys are handled here; a JWK with a private member is refused.
library;

import 'dart:convert';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';

/// Signature metadata of a bundle (from the `/v1/bundle` headers and body, or a live message).
final class SignatureInfo {
  const SignatureInfo({required this.signature, required this.kid, required this.environmentId, required this.revision, required this.checksum});

  /// base64url Ed25519 signature (64 bytes, no padding).
  final String signature;

  /// Key id (`X-NanoFlags-Key-Id`); null when the edge sent none.
  final String? kid;
  final String environmentId;
  final int revision;
  final String checksum;

  Map<String, Object?> toJson() => {'signature': signature, 'kid': kid, 'environmentId': environmentId, 'revision': revision, 'checksum': checksum};

  /// Parses [toJson] output; null when malformed.
  static SignatureInfo? fromJson(Object? v) {
    if (v is! Map) return null;
    final s = v['signature'], k = v['kid'], e = v['environmentId'], r = v['revision'], c = v['checksum'];
    if (s is! String || e is! String || c is! String || r is! int || (k != null && k is! String)) return null;
    return SignatureInfo(signature: s, kid: k as String?, environmentId: e, revision: r, checksum: c);
  }
}

/// A public key ready for verification.
final class ImportedKey {
  const ImportedKey(this.kid, this.key);
  final String? kid;
  final SimplePublicKey key;
}

/// The string the edge signs for a bundle.
String canonicalString(String environmentId, int revision, String checksum, String bundleSha256Hex) =>
    'nanoflags-bundle-v1\n$environmentId\n$revision\n$checksum\n$bundleSha256Hex';

/// Lowercase hex SHA-256 of the UTF-8 bytes of [text].
String sha256Hex(String text) => crypto.sha256.convert(utf8.encode(text)).toString();

final RegExp _b64url = RegExp(r'^[A-Za-z0-9_-]*$');

/// Strict base64url decoding (padding optional). Throws [FormatException] for anything else.
List<int> base64UrlDecodeStrict(String input) {
  final s = input.replaceAll(RegExp(r'=+$'), '');
  if (!_b64url.hasMatch(s) || s.length % 4 == 1) throw const FormatException('Malformed base64url value.');
  return base64Url.decode(s + '=' * ((4 - s.length % 4) % 4));
}

/// True for a public Ed25519 JWK (`{kty: OKP, crv: Ed25519, x}` without a private `d` member).
bool isPublicEd25519Jwk(Object? v) =>
    v is Map && v['kty'] == 'OKP' && v['crv'] == 'Ed25519' && v['x'] is String && !v.containsKey('d');

/// Imports the public Ed25519 JWKs of [jwks]; anything else (including private keys) is skipped.
List<ImportedKey> importPublicKeys(Iterable<Object?> jwks) {
  final out = <ImportedKey>[];
  for (final jwk in jwks) {
    if (!isPublicEd25519Jwk(jwk)) continue;
    final m = jwk as Map;
    try {
      final x = base64UrlDecodeStrict(m['x'] as String);
      if (x.length != 32) continue;
      // Only the public member is used: kid/use/alg/key_ops never influence the key.
      out.add(ImportedKey(m['kid'] is String ? m['kid'] as String : null, SimplePublicKey(x, type: KeyPairType.ed25519)));
    } on FormatException {
      continue;
    }
  }
  return out;
}

final Ed25519 _ed25519 = Ed25519();

/// True when [info] carries a valid signature by one of [keys] over the canonical string for [bundleText].
///
/// A key id narrows the candidates; an unknown key id is not "any key" (keys without a kid still apply).
Future<bool> verifyBundleText(List<ImportedKey> keys, SignatureInfo info, String bundleText) async {
  List<int> signature;
  try {
    signature = base64UrlDecodeStrict(info.signature);
  } on FormatException {
    return false;
  }
  if (signature.length != 64) return false;
  final data = utf8.encode(canonicalString(info.environmentId, info.revision, info.checksum, sha256Hex(bundleText)));
  final candidates = info.kid == null ? keys : keys.where((k) => k.kid == info.kid || k.kid == null);
  for (final k in candidates) {
    try {
      if (await _ed25519.verify(data, signature: Signature(signature, publicKey: k.key))) return true;
    } catch (_) {
      // try the next key
    }
  }
  return false;
}

/// Returns the exact source text of the top-level [member] of the JSON object [text], or null.
///
/// The edge embeds the stored bundle text byte-for-byte; hashing that span avoids depending on
/// re-serialisation. When the member occurs more than once the LAST one wins, like `JSON.parse`.
String? rawMember(String text, String member) {
  var i = 0;
  final n = text.length;
  bool isWs(int c) => c == 0x20 || c == 0x0a || c == 0x0d || c == 0x09;
  void ws() {
    while (i < n && isWs(text.codeUnitAt(i))) {
      i++;
    }
  }

  String? str() {
    if (i >= n || text.codeUnitAt(i) != 0x22) return null;
    final start = i++;
    while (i < n) {
      final c = text.codeUnitAt(i);
      if (c == 0x5c) {
        i += 2;
      } else if (c == 0x22) {
        return text.substring(start, ++i);
      } else {
        i++;
      }
    }
    return null;
  }

  bool value() {
    ws();
    if (i >= n) return false;
    final c = text.codeUnitAt(i);
    if (c == 0x22) return str() != null;
    if (c == 0x7b || c == 0x5b) {
      var depth = 0;
      while (i < n) {
        final d = text.codeUnitAt(i);
        if (d == 0x22) {
          if (str() == null) return false;
          continue;
        }
        if (d == 0x7b || d == 0x5b) {
          depth++;
        } else if (d == 0x7d || d == 0x5d) {
          depth--;
        }
        i++;
        if (depth == 0) return true;
      }
      return false;
    }
    final start = i;
    while (i < n && !',}] \n\r\t'.contains(text[i])) {
      i++;
    }
    return i > start;
  }

  ws();
  if (i >= n || text.codeUnitAt(i) != 0x7b) return null;
  i++;
  String? found;
  for (;;) {
    ws();
    if (i < n && text.codeUnitAt(i) == 0x7d) return found;
    final key = str();
    if (key == null) return null;
    ws();
    if (i >= n || text.codeUnitAt(i) != 0x3a) return null;
    i++;
    ws();
    final start = i;
    if (!value()) return null;
    Object? name;
    try {
      name = jsonDecode(key);
    } on FormatException {
      return null;
    }
    if (name == member) found = text.substring(start, i);
    ws();
    if (i < n && text.codeUnitAt(i) == 0x2c) {
      i++;
    } else if (i < n && text.codeUnitAt(i) == 0x7d) {
      return found;
    } else {
      return null;
    }
  }
}
