// NanoFlags Flutter example: the public live demo.
//
//   flutter run --dart-define=NANOFLAGS_SDK_KEY=nf_pub_…
//
// Toggle the demo flags on https://nanoflags.io (or POST https://edge.nanoflags.io/v1/demo/toggle)
// and watch the screen update live.
import 'package:flutter/widgets.dart';
import 'package:nanoflags_flutter/nanoflags_flutter.dart';

const String demoKey = String.fromEnvironment('NANOFLAGS_SDK_KEY');

const Map<String, Color> accentColors = {
  'blue': Color(0xFF2563EB),
  'orange': Color(0xFFEA580C),
  'green': Color(0xFF16A34A),
};

void main() {
  runApp(const DemoApp());
}

class DemoApp extends StatelessWidget {
  const DemoApp({super.key, this.options});

  /// Overrides the default options (tests).
  final NanoFlagsOptions? options;

  @override
  Widget build(BuildContext context) {
    if (demoKey.isEmpty && options == null) {
      return const Directionality(
        textDirection: TextDirection.ltr,
        child: Center(child: Text('Run with --dart-define=NANOFLAGS_SDK_KEY=nf_pub_…')),
      );
    }
    return NanoFlagsProvider.create(
      options: options ?? const NanoFlagsOptions(sdkKey: demoKey, service: 'flutter-example', context: {'key': 'flutter-example'}),
      child: const Directionality(textDirection: TextDirection.ltr, child: DemoScreen()),
    );
  }
}

class DemoScreen extends StatelessWidget {
  const DemoScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final flags = context.nanoFlags;
    return FlagBuilder<String>(
      flagKey: 'demo-accent',
      fallback: 'blue',
      builder: (context, accent) => ColoredBox(
        key: const ValueKey('accent-box'),
        color: accentColors[accent] ?? const Color(0xFF64748B),
        child: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text('accent: $accent', key: const ValueKey('accent'), style: const TextStyle(fontSize: 28, color: Color(0xFFFFFFFF))),
            FlagBuilder<bool>(
              flagKey: 'demo-new-checkout',
              fallback: false,
              builder: (_, on) => Text('new checkout: $on', key: const ValueKey('checkout'), style: const TextStyle(color: Color(0xFFFFFFFF))),
            ),
            Text('revision ${flags.revision ?? '-'} · ${flags.status.name} · ${flags.transport.name}',
                key: const ValueKey('meta'), style: const TextStyle(color: Color(0xFFFFFFFF))),
          ]),
        ),
      ),
    );
  }
}
