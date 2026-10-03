/// Pure-Dart entry point for the diagnostics telemetry format.
///
/// Separate from `device_bridge.dart` so command line tools and non-Flutter
/// tests can read a telemetry file without pulling in `dart:ui`.
library;

export 'src/diagnostics_telemetry.dart';
