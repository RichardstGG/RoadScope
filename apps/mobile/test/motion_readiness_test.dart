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
    'unavailable sensors do not show numeric angles or start recording',
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
      expect(find.textContaining('尚未驗證道路準確度'), findsOneWidget);
      expect(find.textContaining('傾角 —'), findsOneWidget);
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

  testWidgets(
    'calibration controls use native state and display persisted estimates',
    (tester) async {
      final calls = <MethodCall>[];
      var status = <String, Object?>{
        'state': 'recording',
        'leanState': 'available',
        'calibrationState': 'idle',
        'leanAngleDeg': -12.5,
        'maxLeft': 11.0,
        'maxRight': null,
      };
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            if (call.method == 'motionStatus') return status;
            if (call.method == 'leanCalibration') {
              status = {...status, 'calibrationState': 'awaiting_left'};
              return null;
            }
            return <String, Object?>{};
          });
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(body: SingleChildScrollView(child: MotionReadiness())),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.textContaining('傾角 -12.5° · 最大左傾 11.0° · 最大右傾 —'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<OutlinedButton>(find.widgetWithText(OutlinedButton, '左傾確認'))
            .onPressed,
        isNull,
      );
      await tester.tap(find.text('直立校準'));
      await tester.pumpAndSettle();
      expect(
        calls.where((c) => c.method == 'leanCalibration').single.arguments,
        {'action': 'upright'},
      );
      expect(
        tester
            .widget<OutlinedButton>(find.widgetWithText(OutlinedButton, '左傾確認'))
            .onPressed,
        isNotNull,
      );
      expect(find.textContaining('直立完成，請安全左傾並確認'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
