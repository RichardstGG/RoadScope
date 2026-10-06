import 'package:device_bridge/device_bridge.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('device_bridge');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test(
    'start, status, read and stop use the native recorder channel',
    () async {
      final calls = <String>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        return switch (call.method) {
          'status' => <String, Object?>{
            'state': 'recording',
            'recordingId': 'rec-1',
            'logPath': '/tmp/rec-1.ndjson',
            'sampleAgeMs': 1250,
            'platform': 'android',
            'manufacturer': 'Xiaomi',
            'notificationPermissionGranted': false,
            'batteryOptimizationIgnored': true,
            'vendorBackgroundSetupRecommended': true,
          },
          'readLog' => '{"sample":1}\n',
          _ => null,
        };
      });
      const bridge = DeviceBridge();
      await bridge.start();
      final status = await bridge.status();
      expect(status.isRecording, isTrue);
      expect(status.recordingId, 'rec-1');
      expect(status.sampleAgeMs, 1250.0);
      expect(status.platform, 'android');
      expect(status.manufacturer, 'Xiaomi');
      expect(status.notificationPermissionGranted, isFalse);
      expect(status.batteryOptimizationIgnored, isTrue);
      expect(status.vendorBackgroundSetupRecommended, isTrue);
      expect(await bridge.readLog(), '{"sample":1}\n');
      await bridge.stop();
      expect(calls, ['start', 'status', 'readLog', 'stop']);
    },
  );

  test('background settings methods use their native channel calls', () async {
    final calls = <String>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return null;
    });
    const bridge = DeviceBridge();
    await bridge.openAppSettings();
    await bridge.openBatteryOptimizationSettings();
    expect(calls, ['openAppSettings', 'openBatteryOptimizationSettings']);
  });

  test('lean control is an explicit native action and motion status is a small map', () async {
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (call.method == 'motionStatus') {
        return {'leanAngleDeg': null, 'leanState': 'unavailable'};
      }
      return null;
    });
    const bridge = DeviceBridge();
    expect((await bridge.motionStatus())['leanAngleDeg'], isNull);
    await bridge.leanCalibration('upright');
    expect(calls.last.method, 'leanCalibration');
    expect(calls.last.arguments, {'action': 'upright'});
  });

  test('interrupted and resuming states have explicit control semantics', () {
    const interrupted = RecorderStatus(state: 'interrupted');
    const resuming = RecorderStatus(state: 'resuming');

    expect(interrupted.isRecording, isFalse);
    expect(interrupted.canResume, isTrue);
    expect(resuming.isRecording, isTrue);
    expect(resuming.canResume, isFalse);
  });
}
