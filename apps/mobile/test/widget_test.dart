import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:roadscope/main.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('device_bridge');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  testWidgets('診斷畫面顯示原生記錄狀態與樣本欄位', (tester) async {
    messenger.setMockMethodCallHandler(
      channel,
      (call) async => switch (call.method) {
        'status' => <String, Object?>{'state': 'idle'},
        'readLog' => '',
        _ => null,
      },
    );
    await tester.pumpWidget(const RoadScopeApp());
    await tester.pump();

    expect(find.text('RoadScope 定位診斷'), findsOneWidget);
    expect(find.text('未記錄'), findsOneWidget);
    expect(find.text('開始記錄'), findsOneWidget);
    expect(find.textContaining('尚無樣本'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('開始與停止由原生記錄狀態決定', (tester) async {
    var state = 'idle';
    final calls = <String>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      if (call.method == 'start') state = 'recording';
      if (call.method == 'stop') state = 'idle';
      return switch (call.method) {
        'status' => <String, Object?>{'state': state},
        'readLog' => '',
        _ => null,
      };
    });
    await tester.pumpWidget(const RoadScopeApp());
    await tester.pump();
    await tester.tap(find.text('開始記錄'));
    await tester.pump();
    await tester.pump();
    expect(find.text('停止記錄'), findsOneWidget);
    await tester.tap(find.text('停止記錄'));
    await tester.pump();
    await tester.pump();
    expect(find.text('開始記錄'), findsOneWidget);
    expect(calls, containsAllInOrder(['start', 'stop']));
  });
}
