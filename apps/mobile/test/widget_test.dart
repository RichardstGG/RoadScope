import 'package:flutter_test/flutter_test.dart';
import 'package:roadscope/main.dart';

void main() {
  testWidgets('bootstrap 畫面清楚標示尚未開始定位記錄', (tester) async {
    await tester.pumpWidget(const RoadScopeApp());

    expect(find.text('RoadScope'), findsOneWidget);
    expect(find.text('記錄器尚未啟用'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
