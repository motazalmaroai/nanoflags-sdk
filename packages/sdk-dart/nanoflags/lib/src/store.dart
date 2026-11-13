import 'dart:async';

/// On-device persistence for the last verified bundle (offline-first start).
///
/// Values are opaque strings owned by the SDK (a few KB to a few hundred KB: the signed bundle
/// text and its signature). Entries are keyed by a non-secret fingerprint of the edge URL and SDK
/// key. Implementations must not throw; unavailable storage behaves like an empty store.
///
/// Implementations: [MemoryStore] here, `FileStore` in `package:nanoflags/io.dart` (native
/// platforms), `SharedPreferencesStore` in `package:nanoflags_flutter`.
abstract interface class NanoFlagsStore {
  /// The value stored under [id], or null.
  Future<String?> read(String id);

  /// Replaces the value stored under [id].
  Future<void> write(String id, String value);
}

/// Keeps the bundle in memory only (tests, or apps that do not want anything on disk).
final class MemoryStore implements NanoFlagsStore {
  final Map<String, String> _values = {};

  @override
  Future<String?> read(String id) async => _values[id];

  @override
  Future<void> write(String id, String value) async => _values[id] = value;
}
