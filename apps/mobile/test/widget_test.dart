import 'dart:io';

import 'package:flutter/material.dart';
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
  testWidgets('定位逾期後隱藏舊速度，收到新定位後恢復', (tester) async {
    var age = 1000.0;
    final text = File(
      '../../testdata/contracts/location-log/v1/valid/01-android-minimal.ndjson',
    ).readAsStringSync();
    messenger.setMockMethodCallHandler(
      channel,
      (call) async => switch (call.method) {
        'status' => <String, Object?>{'state': 'recording', 'sampleAgeMs': age},
        'readLog' => text,
        _ => null,
      },
    );
    await tester.pumpWidget(const RoadScopeApp());
    await tester.pump();
    expect(find.text('-- km/h'), findsNothing);
    age = staleSampleAgeMs + 1;
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text('-- km/h'), findsOneWidget);
    expect(find.textContaining('無新定位'), findsOneWidget);
    age = 0;
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text('-- km/h'), findsNothing);
  });

  group('診斷 telemetry 區塊', () {
    const fixtures = '../../testdata/device/diagnostics-telemetry/v1';

    Future<void> pump(
      WidgetTester tester, {
      required String telemetry,
      String state = 'idle',
      String? logPath,
      String? telemetryPath,
    }) async {
      messenger.setMockMethodCallHandler(
        channel,
        (call) async => switch (call.method) {
          'status' => <String, Object?>{
            'state': state,
            'logPath': logPath,
            'telemetryPath': telemetryPath,
          },
          'readLog' => '',
          'readTelemetry' => telemetry,
          _ => null,
        },
      );
      // The diagnostics list is long; give the test a surface tall enough to
      // lay all of it out instead of scrolling for every expectation.
      tester.view.physicalSize = const Size(1400, 5000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(const RoadScopeApp());
      await tester.pump();
    }

    testWidgets('沒有 telemetry 時說明尚無紀錄且不可匯出', (tester) async {
      await pump(tester, telemetry: '');
      expect(find.textContaining('尚無 telemetry'), findsOneWidget);
      expect(find.text('telemetry 可匯出：目前不可匯出'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Android telemetry 顯示電量、前後台、螢幕與定位服務狀態', (tester) async {
      await pump(
        tester,
        telemetry: File('$fixtures/android-state-changes.ndjson')
            .readAsStringSync(),
        telemetryPath: '/tmp/rec.telemetry.ndjson',
      );
      expect(find.text('電量：81%'), findsOneWidget);
      expect(find.text('充電狀態：充電中'), findsOneWidget);
      expect(find.text('電源來源：USB'), findsOneWidget);
      expect(find.text('App 狀態：前景'), findsOneWidget);
      expect(find.text('螢幕可互動：是'), findsOneWidget);
      expect(find.text('keyguard 狀態：未上鎖'), findsOneWidget);
      expect(find.text('定位服務狀態：已停止'), findsOneWidget);
      expect(
        find.text('telemetry 時間（UTC）：2026-10-03T04:10:00.000Z'),
        findsOneWidget,
      );
      expect(find.text('telemetry 筆數／壞行：5／0'), findsOneWidget);
      expect(find.text('telemetry 可匯出：可匯出'), findsOneWidget);
      // Android has no iOS protected-data signal, and that must read as
      // unavailable rather than as a false.
      expect(find.text('iOS 保護資料可用：無法取得（not available）'), findsOneWidget);
    });

    testWidgets('iOS 未知的螢幕狀態顯示 not available，不顯示成 false', (tester) async {
      await pump(
        tester,
        telemetry: File('$fixtures/ios-screen-state-unavailable.ndjson')
            .readAsStringSync(),
        telemetryPath: '/tmp/rec.telemetry.ndjson',
      );
      expect(find.text('螢幕可互動：無法取得（not available）'), findsOneWidget);
      expect(find.text('keyguard 狀態：無法取得（not available）'), findsOneWidget);
      expect(find.text('螢幕可互動：否'), findsNothing);
      expect(find.text('keyguard 狀態：未上鎖'), findsNothing);
      expect(
        find.text('螢幕狀態來源：ios_no_public_lock_api_protected_data_only'),
        findsOneWidget,
      );
      // Battery unobservable: shown as unavailable, never as 0%.
      expect(find.text('電量：無法取得（not available）'), findsOneWidget);
      expect(find.text('充電狀態：無法取得（not available）'), findsOneWidget);
      expect(find.text('電源來源：未知（unknown）'), findsOneWidget);
      expect(find.text('App 狀態：背景'), findsOneWidget);
      expect(find.text('定位服務狀態：已重建'), findsOneWidget);
      expect(find.text('恢復原因：重開機後恢復'), findsOneWidget);
      expect(find.text('程序重啟次數：1'), findsOneWidget);
    });

    testWidgets('壞資料不會讓畫面崩潰，並回報壞行數', (tester) async {
      await pump(
        tester,
        telemetry: File('$fixtures/invalid-and-tolerated.ndjson')
            .readAsStringSync(),
        telemetryPath: '/tmp/rec.telemetry.ndjson',
      );
      expect(find.textContaining('telemetry 筆數／壞行：2／7'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    final logButton = find.widgetWithText(OutlinedButton, '匯出 location-log v1');
    final telemetryButton = find.widgetWithText(
      OutlinedButton,
      '匯出 diagnostics telemetry',
    );

    testWidgets('記錄中兩種匯出都停用', (tester) async {
      await pump(
        tester,
        telemetry: File('$fixtures/android-state-changes.ndjson')
            .readAsStringSync(),
        state: 'recording',
        logPath: '/tmp/rec.ndjson',
        telemetryPath: '/tmp/rec.telemetry.ndjson',
      );
      expect(logButton, findsOneWidget);
      expect(telemetryButton, findsOneWidget);
      expect(tester.widget<OutlinedButton>(logButton).onPressed, isNull);
      expect(tester.widget<OutlinedButton>(telemetryButton).onPressed, isNull);
    });

    testWidgets('停止後兩種格式各自分開匯出', (tester) async {
      await pump(
        tester,
        telemetry: File('$fixtures/android-state-changes.ndjson')
            .readAsStringSync(),
        logPath: '/tmp/rec.ndjson',
        telemetryPath: '/tmp/rec.telemetry.ndjson',
      );
      expect(tester.widget<OutlinedButton>(logButton).onPressed, isNotNull);
      expect(
        tester.widget<OutlinedButton>(telemetryButton).onPressed,
        isNotNull,
      );
    });

    testWidgets('有紀錄檔但沒有 telemetry 時只有 location-log 可匯出', (tester) async {
      await pump(
        tester,
        telemetry: '',
        logPath: '/tmp/rec.ndjson',
        telemetryPath: '/tmp/rec.telemetry.ndjson',
      );
      expect(tester.widget<OutlinedButton>(logButton).onPressed, isNotNull);
      expect(tester.widget<OutlinedButton>(telemetryButton).onPressed, isNull);
    });
  });
}
