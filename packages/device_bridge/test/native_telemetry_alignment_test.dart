import 'dart:io';

import 'package:device_bridge/device_bridge.dart';
import 'package:flutter_test/flutter_test.dart';

/// Static validation of the two native telemetry writers.
///
/// Neither writer can be executed here: Android needs the framework and iOS
/// needs a Mac. These checks therefore assert the properties that would be
/// expensive to discover on a device — a field that exists on one platform and
/// not the other, position data leaking into diagnostics, or a monotonic clock
/// that stops during sleep. They are static validation, not hardware evidence.
/// Source with comments removed, so a rule can check the code rather than the
/// prose that explains it.
String _code(String source) => source
    .split('\n')
    .map((line) {
      final comment = line.indexOf('//');
      return comment < 0 ? line : line.substring(0, comment);
    })
    .join('\n');

/// The body of one function, from its declaration to the next declaration at
/// the same level. Enough for a static check that a function does not reach
/// for something it must not touch.
String _body(String source, String declaration, String nextDeclaration) {
  final start = source.indexOf(declaration);
  if (start < 0) return '';
  final end = source.indexOf(nextDeclaration, start + declaration.length);
  return source.substring(start, end < 0 ? source.length : end);
}

void main() {
  final kotlin = File(
    'android/src/main/kotlin/tw/idv/richardwutt/device_bridge/TelemetryLogWriter.kt',
  ).readAsStringSync();
  final swift = File(
    'ios/device_bridge/Sources/device_bridge/DiagnosticsTelemetry.swift',
  ).readAsStringSync();
  final plugin = File(
    'ios/device_bridge/Sources/device_bridge/DeviceBridgePlugin.swift',
  ).readAsStringSync();

  /// Keys the Kotlin writer puts into a row.
  // Row fields are `put("key", value)`; a flag is `put("flag")` with no value.
  Set<String> kotlinFields() =>
      RegExp(r'\.put\("(\w+)",')
          .allMatches(kotlin)
          .map((match) => match.group(1)!)
          .toSet();

  /// Keys in the Swift `row(...)` dictionary literal.
  Set<String> swiftFields() {
    final start = swift.indexOf('    return [');
    final end = swift.indexOf('\n    ]', start);
    expect(start, greaterThan(0), reason: 'row() dictionary literal not found');
    return RegExp(r'"(\w+)":')
        .allMatches(swift.substring(start, end))
        .map((match) => match.group(1)!)
        .toSet();
  }

  test('both writers emit exactly the fields the reader knows', () {
    expect(kotlinFields(), diagnosticsTelemetryFields);
    expect(swiftFields(), diagnosticsTelemetryFields);
  });

  test('neither writer can put position data in telemetry', () {
    for (final key in [
      'latDeg',
      'lonDeg',
      'altitudeM',
      'speedMps',
      'headingDeg',
      'horizontalAccuracyM',
      'speedAccuracyMps',
    ]) {
      expect(kotlin.contains('"$key"'), isFalse, reason: 'Kotlin writes $key');
      expect(swift.contains('"$key"'), isFalse, reason: 'Swift writes $key');
    }
  });

  test('telemetry never reuses location-log v1 record identity', () {
    for (final key in ['schemaVersion', 'eventType', 'lastSequence']) {
      expect(kotlin.contains('"$key"'), isFalse, reason: 'Kotlin writes $key');
      expect(swift.contains('"$key"'), isFalse, reason: 'Swift writes $key');
    }
    // Its own record type and its own sequence field, so a consumer of the
    // location log sees an unknown recordType it is told to preserve.
    expect(kotlin, contains('"diagnostics_telemetry"'));
    expect(swift, contains('"diagnostics_telemetry"'));
    expect(kotlinFields(), contains('telemetrySequence'));
    expect(kotlinFields(), isNot(contains('sequence')));
    expect(swiftFields(), isNot(contains('sequence')));
  });

  test('iOS telemetry uses the sleep-inclusive monotonic clock', () {
    // contracts/location-log/v1 §3: mach_absolute_time and systemUptime stop
    // during sleep, which is most of a locked long run.
    expect(swift, contains('mach_continuous_time()'));
    for (final source in [_code(swift), _code(plugin)]) {
      expect(source.contains('mach_absolute_time'), isFalse);
      expect(source.contains('systemUptime'), isFalse);
    }
    // One clock for both logs, so the two files share a time domain.
    expect(plugin, contains('MonotonicClock.continuousMicroseconds()'));
  });

  test('iOS never renames an unobservable screen state', () {
    expect(swift, contains('observation.screenInteractive = nil'));
    expect(swift, contains('observation.keyguardLocked = nil'));
    expect(swift, contains('"ios_no_public_lock_api_protected_data_only"'));
    // Background is reported as background, never as locked.
    expect(
      swift,
      contains('case .background: observation.appLifecycle = "background"'),
    );
    expect(_code(swift).contains('appLifecycle = "locked"'), isFalse);
    expect(_code(swift).contains('keyguardLocked = true'), isFalse);
  });

  test('iOS relaunch requires an explicit foreground resume action', () {
    final initializer = _body(
      _code(plugin),
      'override init()',
      '  public func handle',
    );
    expect(
      initializer,
      contains('resuming = defaults.bool(forKey: "roadscope.active")'),
    );
    expect(initializer, isNot(contains('activateIfAuthorized()')));
    expect(plugin, contains('startRequestedInThisProcess = true'));
    expect(plugin, contains('!startRequestedInThisProcess'));
    expect(plugin, contains('case "start":'));
    expect(plugin, contains('activateIfAuthorized()'));
  });

  test('Android does not silently resume location after device boot', () {
    final manifests = [
      File('android/src/main/AndroidManifest.xml').readAsStringSync(),
      File('../../apps/mobile/android/app/src/main/AndroidManifest.xml')
          .readAsStringSync(),
    ].join('\n');
    expect(manifests, isNot(contains('BOOT_COMPLETED')));
    expect(manifests, isNot(contains('LOCKED_BOOT_COMPLETED')));
    expect(manifests, isNot(contains('BootReceiver')));
  });

  test('Android names the two APIs its screen fields come from', () {
    final snapshot = File(
      'android/src/main/kotlin/tw/idv/richardwutt/device_bridge/TelemetrySnapshot.kt',
    ).readAsStringSync();
    final monitor = File(
      'android/src/main/kotlin/tw/idv/richardwutt/device_bridge/DeviceStateMonitor.kt',
    ).readAsStringSync();
    expect(
      snapshot,
      contains('"android_power_manager_interactive_and_keyguard_locked"'),
    );
    expect(monitor, contains('power?.isInteractive'));
    expect(monitor, contains('keyguard?.isKeyguardLocked'));
  });

  test('the opening row can know whether the app was in the foreground', () {
    final monitor = File(
      'android/src/main/kotlin/tw/idv/richardwutt/device_bridge/DeviceStateMonitor.kt',
    ).readAsStringSync();
    final plugin = File(
      'android/src/main/kotlin/tw/idv/richardwutt/device_bridge/DeviceBridgePlugin.kt',
    ).readAsStringSync();
    final service = File(
      'android/src/main/kotlin/tw/idv/richardwutt/device_bridge/LocationRecorderService.kt',
    ).readAsStringSync();
    // ActivityLifecycleCallbacks never replays the already-started activity,
    // so the state has to be handed in from the side that knows it.
    expect(monitor, contains('initialForeground != null'));
    expect(monitor, contains('sawActivity = true'));
    expect(plugin, contains('EXTRA_INITIAL_FOREGROUND'));
    expect(service, contains('EXTRA_INITIAL_FOREGROUND'));
    // A system-initiated restart has no activity to report, so it stays unknown.
    expect(service, contains('} else null'));
    // iOS reads the state directly and needs no seed.
    expect(swift, contains('UIApplication.shared.applicationState'));
  });

  test('an interrupted segment is markable on both platforms', () {
    final service = File(
      'android/src/main/kotlin/tw/idv/richardwutt/device_bridge/LocationRecorderService.kt',
    ).readAsStringSync();
    for (final source in [kotlin, swift]) {
      expect(source, contains('recording_interrupted'));
    }
    expect(service, contains('markInterrupted()'));
    expect(plugin, contains('markInterrupted()'));
    // The marker reports how far the location log got, read-only.
    expect(service, contains('lastLoggedSequence'));
    expect(plugin, contains('lastLoggedSequence'));
    // Each side names the trigger through its own writer's constant, so the
    // literal only ever exists in one place per platform.
    expect(_code(service), contains('TRIGGER_RECORDING_INTERRUPTED'));
    expect(_code(plugin), contains('.recordingInterrupted'));
    // The marker must not put an event into the location log: v1 has no such
    // eventType, and adding one would need a contract change. The iOS plugin
    // is also the location-log writer, so this is checked per function body.
    for (final body in [
      _body(
        _code(service),
        'private fun markInterrupted()',
        '    private fun ',
      ),
      _body(_code(plugin), 'private func markInterrupted()', '  private func '),
    ]) {
      expect(body, isNot(contains('eventType')));
      expect(body, isNot(contains('event(')));
      // It does report how far the location log got.
      expect(body, contains('lastLoggedSequence'));
    }
  });

  test('task removal trigger is synchronized and Android observes it', () {
    final service = File(
      'android/src/main/kotlin/tw/idv/richardwutt/device_bridge/LocationRecorderService.kt',
    ).readAsStringSync();
    expect(kotlin, contains('"task_removed"'));
    expect(swift, contains('"task_removed"'));
    expect(service, contains('override fun onTaskRemoved'));
    expect(service, contains('noteTaskRemoved()'));
  });

  test('both writers only advance their sequence after a durable append', () {
    expect(kotlin, contains('output.fd.sync()'));
    expect(swift, contains('try handle.synchronize()'));
    expect(
      kotlin.indexOf('output.fd.sync()'),
      lessThan(kotlin.indexOf('sequence++')),
    );
    expect(
      swift.indexOf('try append(row)'),
      lessThan(swift.indexOf('sequence += 1')),
    );
  });
}
