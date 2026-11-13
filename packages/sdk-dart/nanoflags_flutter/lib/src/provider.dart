import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:nanoflags/nanoflags.dart';

import 'shared_preferences_store.dart';

/// Makes a [NanoFlagsClient] available to the widget tree, rebuilds dependents when a flag can have
/// changed (new configuration, status or context), and follows the app lifecycle: in the background
/// the live connection is closed and polling stops ([NanoFlagsClient.pause]); back in the foreground
/// the client reconnects and revalidates ([NanoFlagsClient.resume]).
///
/// ```dart
/// runApp(NanoFlagsProvider.create(
///   options: const NanoFlagsOptions(sdkKey: 'nf_pub_…', service: 'ios-app'),
///   child: const MyApp(),
/// ));
/// ```
class NanoFlagsProvider extends StatefulWidget {
  /// Provides an existing [client]. The provider does not close it.
  const NanoFlagsProvider({super.key, required NanoFlagsClient this.client, required this.child, this.handleLifecycle = true}) : options = null;

  /// Creates (and on dispose closes) a client from [options]. Without a `store` in [options] the
  /// last verified bundle is persisted with [SharedPreferencesStore].
  const NanoFlagsProvider.create({super.key, required NanoFlagsOptions this.options, required this.child, this.handleLifecycle = true}) : client = null;

  final NanoFlagsClient? client;
  final NanoFlagsOptions? options;
  final Widget child;

  /// Pause in the background and resume in the foreground (default true).
  final bool handleLifecycle;

  /// The nearest client; registers [context] for rebuilds on changes. Throws when there is none.
  static NanoFlagsClient of(BuildContext context) {
    final client = maybeOf(context);
    if (client == null) {
      throw FlutterError.fromParts([
        ErrorSummary('NanoFlagsProvider.of() called with a context that does not contain a NanoFlagsProvider.'),
        ErrorHint('Wrap your app (or this subtree) in NanoFlagsProvider or NanoFlagsProvider.create.'),
      ]);
    }
    return client;
  }

  /// The nearest client, or null; registers [context] for rebuilds on changes.
  static NanoFlagsClient? maybeOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<_NanoFlagsScope>()?.client;

  /// The nearest client without registering for rebuilds (for callbacks such as `onPressed`).
  static NanoFlagsClient? read(BuildContext context) => context.getInheritedWidgetOfExactType<_NanoFlagsScope>()?.client;

  @override
  State<NanoFlagsProvider> createState() => _NanoFlagsProviderState();
}

class _NanoFlagsProviderState extends State<NanoFlagsProvider> with WidgetsBindingObserver {
  late NanoFlagsClient _client;
  bool _owned = false;
  StreamSubscription<void>? _sub;
  int _version = 0;

  @override
  void initState() {
    super.initState();
    _attach();
    if (widget.handleLifecycle) WidgetsBinding.instance.addObserver(this);
  }

  void _attach() {
    final given = widget.client;
    if (given != null) {
      _client = given;
      _owned = false;
    } else {
      final options = widget.options!;
      _client = NanoFlagsClient(options.store == null ? options.copyWith(store: SharedPreferencesStore()) : options);
      _owned = true;
    }
    _version = _client.version;
    _sub = _client.changes.listen((_) {
      if (mounted && _client.version != _version) setState(() => _version = _client.version);
    });
  }

  void _detach() {
    unawaited(_sub?.cancel());
    _sub = null;
    if (_owned) unawaited(_client.close());
  }

  @override
  void didUpdateWidget(NanoFlagsProvider oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.client, widget.client) || (widget.client == null && !identical(oldWidget.options, widget.options))) {
      _detach();
      _attach();
    }
    if (oldWidget.handleLifecycle != widget.handleLifecycle) {
      if (widget.handleLifecycle) {
        WidgetsBinding.instance.addObserver(this);
      } else {
        WidgetsBinding.instance.removeObserver(this);
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        _client.resume();
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        _client.pause();
      case AppLifecycleState.inactive:
        // Transient (a dialog, the app switcher, an incoming call): keep the connection.
        break;
    }
  }

  @override
  void dispose() {
    if (widget.handleLifecycle) WidgetsBinding.instance.removeObserver(this);
    _detach();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => _NanoFlagsScope(client: _client, version: _version, child: widget.child);
}

class _NanoFlagsScope extends InheritedWidget {
  const _NanoFlagsScope({required this.client, required this.version, required super.child});

  final NanoFlagsClient client;
  final int version;

  @override
  bool updateShouldNotify(_NanoFlagsScope oldWidget) => !identical(client, oldWidget.client) || version != oldWidget.version;
}

/// `context.nanoFlags`: the nearest client (rebuilds this widget on changes).
extension NanoFlagsBuildContext on BuildContext {
  NanoFlagsClient get nanoFlags => NanoFlagsProvider.of(this);
}
