import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:roadscope/motion_readiness.dart';

void main() {
  const channel = MethodChannel('device_bridge');
  TestWidgetsFlutterBinding.ensureInitialized();
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  testWidgets(
    'inventory does not claim lean recording and does not subscribe',
    (tester) async {
      final calls = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call.method);
            if (call.method == 'motionStatus') return {'state': 'idle'};
            return {
              'accelerometer': true,
              'gyroscope': false,
              'leanRecordingAvailable': false,
            };
          });
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: MotionReadiness())),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('陀螺儀：未提供'), findsOneWidget);
      expect(find.textContaining('傾角估算與校準尚未啟用'), findsOneWidget);
      expect(find.textContaining('固定於車把'), findsOneWidget);
      expect(calls, containsAll(['motionCapabilities', 'motionStatus']));
      expect(calls, isNot(contains('start')));
    },
  );

  testWidgets('old plugin or unavailable platform fails visibly', (
    tester,
  ) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (call) async => throw MissingPluginException(),
        );
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: MotionReadiness())),
    );
    await tester.pumpAndSettle();
    expect(find.text('無法讀取感測器能力'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
