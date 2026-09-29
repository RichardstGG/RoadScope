import 'package:flutter/services.dart';

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
      error: raw['error'] as String?,
    );
  }

  Future<String> readLog() async =>
      await _channel.invokeMethod<String>('readLog') ?? '';
}

class RecorderStatus {
  const RecorderStatus({
    required this.state,
    this.recordingId,
    this.logPath,
    this.error,
  });

  final String state;
  final String? recordingId;
  final String? logPath;
  final String? error;

  bool get isRecording => state == 'recording';
}
