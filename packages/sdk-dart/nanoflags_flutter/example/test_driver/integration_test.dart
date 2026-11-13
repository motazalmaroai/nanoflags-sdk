// Host side of `flutter drive` for the integration tests (CI fallback on the iOS simulator, where
// `flutter test integration_test` can fail to attach to the app):
//
//   flutter drive --driver=test_driver/integration_test.dart --target=integration_test/live_demo_test.dart \
//     --dart-define=NANOFLAGS_SDK_KEY=nf_pub_… -d <device>
import 'package:integration_test/integration_test_driver.dart';

Future<void> main() => integrationDriver();
