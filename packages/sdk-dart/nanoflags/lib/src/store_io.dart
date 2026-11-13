import 'dart:io';

import 'store.dart';

/// Persists the bundle as one file per SDK key in [directory] (native platforms only).
///
/// Writes go to a temporary file that is then renamed over the old one, so a crash mid-write
/// never leaves a truncated bundle behind. In Flutter apps, pass the application-support
/// directory (`path_provider`), or use `SharedPreferencesStore` from `package:nanoflags_flutter`.
final class FileStore implements NanoFlagsStore {
  FileStore(this.directory);

  final Directory directory;

  File _file(String id) => File('${directory.path}${Platform.pathSeparator}nanoflags-$id.json');

  @override
  Future<String?> read(String id) async {
    try {
      final f = _file(id);
      return await f.exists() ? await f.readAsString() : null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> write(String id, String value) async {
    try {
      await directory.create(recursive: true);
      final f = _file(id);
      final tmp = File('${f.path}.tmp');
      await tmp.writeAsString(value, flush: true);
      await tmp.rename(f.path);
    } catch (_) {
      // Storage is best effort: the next verified bundle is written again.
    }
  }
}
