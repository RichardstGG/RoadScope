import 'package:flutter/services.dart';

import 'src/diagnostics_telemetry.dart';

export 'src/diagnostics_telemetry.dart';

/// Thin control plane for the native append-only location recorder.
class DeviceBridge {
  const DeviceBridge();

  static const MethodChannel _channel = MethodChannel('device_bridge');

  Future<void> start() async => _channel.invokeMethod<void>('start');
  Future<void> stop() async => _channel.invokeMethod<void>('stop');

  Future<RecorderStatus> status() async {
    final raw = await _channel.invokeMapMethod<String, Object?>('status');
    if (raw == null) throw const FormatException('native status is missing');
    return RecorderStatus(
      state: raw['state'] as String? ?? 'unknown',
      recordingId: raw['recordingId'] as String?,
      logPath: raw['logPath'] as String?,
      telemetryPath: raw['telemetryPath'] as String?,
      error: raw['error'] as String?,
      sampleAgeMs: (raw['sampleAgeMs'] as num?)?.toDouble(),
      platform: raw['platform'] as String?,
      manufacturer: raw['manufacturer'] as String?,
      notificationPermissionGranted:
          raw['notificationPermissionGranted'] as bool?,
      batteryOptimizationIgnored: raw['batteryOptimizationIgnored'] as bool?,
      vendorBackgroundSetupRecommended:
          raw['vendorBackgroundSetupRecommended'] as bool? ?? false,
    );
  }

  Future<void> openAppSettings() async =>
      _channel.invokeMethod<void>('openAppSettings');

  Future<void> openBatteryOptimizationSettings() async =>
      _channel.invokeMethod<void>('openBatteryOptimizationSettings');

  /// Reads the `contracts/location-log/v1` file.
  Future<String> readLog() async =>
      await _channel.invokeMethod<String>('readLog') ?? '';

  /// Reads the diagnostics telemetry file, which is a separate log and is
  /// never merged into [readLog].
  Future<String> readTelemetry() async =>
      await _channel.invokeMethod<String>('readTelemetry') ?? '';

  /// Reads and parses the diagnostics telemetry file in one step.
  Future<TelemetryReadReport> telemetry() async =>
      parseDiagnosticsTelemetry(await readTelemetry());
}

class RecorderStatus {
  const RecorderStatus({
    required this.state,
    this.recordingId,
    this.logPath,
    this.telemetryPath,
    this.error,
    this.sampleAgeMs,
    this.platform,
    this.manufacturer,
    this.notificationPermissionGranted,
    this.batteryOptimizationIgnored,
    this.vendorBackgroundSetupRecommended = false,
  });

  final String state;
  final String? recordingId;

  /// Path of the `location-log` v1 file.
  final String? logPath;

  /// Path of the diagnostics telemetry file, or `null` when the platform did
  /// not report one. Kept separate from [logPath] so an export cannot blur the
  /// two formats together.
  final String? telemetryPath;

  final String? error;
  final double? sampleAgeMs;
  final String? platform;
  final String? manufacturer;
  final bool? notificationPermissionGranted;
  final bool? batteryOptimizationIgnored;
  final bool vendorBackgroundSetupRecommended;

  bool get isRecording => state == 'recording';
}
