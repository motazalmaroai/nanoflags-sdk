import 'package:nanoflags/nanoflags.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Persists the last verified bundle with `shared_preferences` (NSUserDefaults on iOS / macOS,
/// DataStore / SharedPreferences on Android, localStorage on the web).
///
/// Uses the asynchronous API (no in-memory cache of every preference), so a large bundle never
/// sits in memory twice. Entries are named `nanoflags.<fingerprint>`; the fingerprint is a hash of
/// the edge URL and SDK key, not the key itself. For bundles larger than ~1 MB prefer
/// `FileStore` (`package:nanoflags/io.dart`) in the application-support directory.
final class SharedPreferencesStore implements NanoFlagsStore {
  SharedPreferencesStore({SharedPreferencesAsync? preferences, this.prefix = 'nanoflags.'}) : _prefs = preferences;

  SharedPreferencesAsync? _prefs;
  final String prefix;

  SharedPreferencesAsync get _p => _prefs ??= SharedPreferencesAsync();

  @override
  Future<String?> read(String id) async {
    try {
      return await _p.getString('$prefix$id');
    } catch (_) {
      return null; // unavailable storage behaves like an empty store
    }
  }

  @override
  Future<void> write(String id, String value) async {
    try {
      await _p.setString('$prefix$id', value);
    } catch (_) {
      // best effort: the next verified bundle is written again
    }
  }
}
