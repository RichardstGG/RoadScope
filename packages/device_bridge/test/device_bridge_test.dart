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
      expect(await bridge.readLog(), '{"sample":1}\n');
      await bridge.stop();
      expect(calls, ['start', 'status', 'readLog', 'stop']);
    },
  );
}
