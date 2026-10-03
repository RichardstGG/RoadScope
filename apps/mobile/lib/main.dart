import 'dart:async';

import 'package:device_bridge/device_bridge.dart';
import 'package:flutter/material.dart';
import 'package:mobile_data/mobile_data.dart';
import 'package:share_plus/share_plus.dart';

void main() => runApp(const RoadScopeApp());

class RoadScopeApp extends StatelessWidget {
  const RoadScopeApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'RoadScope',
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
      useMaterial3: true,
    ),
    home: const RecorderScreen(),
  );
}

class RecorderScreen extends StatefulWidget {
  const RecorderScreen({super.key});

  @override
  State<RecorderScreen> createState() => _RecorderScreenState();
}

const staleSampleAgeMs = 5000.0;

class _RecorderScreenState extends State<RecorderScreen>
    with WidgetsBindingObserver {
  final DeviceBridge _bridge = const DeviceBridge();
  Timer? _poller;
  RecorderStatus? _status;
  LocationSample? _latest;
  LocationImportReport? _report;
  String? _error;
  bool _busy = false;
  bool _polling = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
    _poller = Timer.periodic(const Duration(seconds: 3), (_) => _refresh());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  @override
  void dispose() {
    _poller?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _refresh() async {
    if (_polling) return;
    _polling = true;
    try {
      final status = await _bridge.status();
      final log = await _bridge.readLog();
      final report = LocationSampleImporter().addNdjson(log);
      final samples = report.allSamples;
      if (!mounted) return;
      setState(() {
        _status = status;
        _report = report;
        _latest = samples.isEmpty ? null : samples.last;
        _error = null;
      });
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      _polling = false;
    }
  }

  Future<void> _toggle() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      if (_status?.isRecording == true ||
          _status?.state == 'waiting_permission') {
        await _bridge.stop();
      } else {
        await _bridge.start();
      }
      await _refresh();
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _export() async {
    final path = _status?.logPath;
    if (path == null) return;
    try {
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(path)],
          text: 'RoadScope 診斷紀錄；包含精確位置，請只分享給信任的接收者。',
        ),
      );
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  String _stateLabel(String? state) => switch (state) {
    'recording' => '記錄中',
    'waiting_permission' => '等待定位授權',
    'error' => '記錄錯誤',
    'idle' => '未記錄',
    _ => '讀取中',
  };

  String _number(double? value, String unit, {int digits = 1}) =>
      value == null ? '無效／未提供' : '${value.toStringAsFixed(digits)} $unit';

  @override
  Widget build(BuildContext context) {
    final sample = _latest;
    final status = _status;
    final samples = _report?.allSamples ?? const <LocationSample>[];
    final previous = samples.length < 2 ? null : samples[samples.length - 2];
    final interval = sample == null || previous == null
        ? null
        : sample.deviceBootId == previous.deviceBootId &&
              sample.measurementMonotonicUs != null &&
              previous.measurementMonotonicUs != null
        ? (sample.measurementMonotonicUs! - previous.measurementMonotonicUs!) /
              1000000
        : sample.measuredAtUtc
                  .difference(previous.measuredAtUtc)
                  .inMicroseconds /
              1000000;
    final age = status?.sampleAgeMs;
    final fresh =
        status?.isRecording == true &&
        _error == null &&
        _report?.ok == true &&
        sample != null &&
        age != null &&
        age >= 0 &&
        age <= staleSampleAgeMs;
    return Scaffold(
      appBar: AppBar(title: const Text('RoadScope 定位診斷')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              _stateLabel(status?.state),
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            if (status?.recordingId != null)
              Text('記錄 ID：${status!.recordingId}'),
            if (status?.error != null)
              Text(
                status!.error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            if (_error != null)
              Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            const SizedBox(height: 16),
            Text(
              !fresh || sample.speedMps == null
                  ? '-- km/h'
                  : '${(sample.speedMps! * 3.6).toStringAsFixed(1)} km/h',
              style: Theme.of(context).textTheme.displayMedium,
            ),
            const SizedBox(height: 12),
            _detail('定位狀態', fresh ? '有新定位' : '無新定位／樣本已過期'),
            _detail('樣本年齡', age == null ? '尚無資料' : _number(age / 1000, '秒')),
            _detail(
              '樣本時間（UTC）',
              sample?.measuredAtUtc.toIso8601String() ?? '尚無樣本',
            ),
            _detail('樣本間隔', interval == null ? '尚無資料' : _number(interval, '秒')),
            if (sample != null &&
                previous != null &&
                (sample.deviceBootId != previous.deviceBootId ||
                    sample.measurementMonotonicUs == null ||
                    previous.measurementMonotonicUs == null))
              const Text('間隔以測量 UTC 推算，可能受校時影響。'),
            _detail('水平精度', _number(sample?.horizontalAccuracyM, '公尺')),
            _detail('速度精度', _number(sample?.speedAccuracyMps, '公尺／秒')),
            _detail('累計樣本', '${samples.length}'),
            _detail(
              '事件／警告',
              '${_report?.events.length ?? 0}／${_report?.findings.where((f) => !f.isError).length ?? 0}',
            ),
            const Text('診斷版 0.0.2+2 · location-log v1'),
            _detail('無效紀錄行', '${_report?.invalidLines ?? 0}'),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: _busy ? null : _toggle,
              icon: Icon(
                status?.isRecording == true
                    ? Icons.stop
                    : Icons.fiber_manual_record,
              ),
              label: Text(
                status?.isRecording == true ||
                        status?.state == 'waiting_permission'
                    ? '停止記錄'
                    : '開始記錄',
              ),
            ),
            OutlinedButton.icon(
              onPressed:
                  _busy ||
                      status?.logPath == null ||
                      status?.isRecording == true ||
                      status?.state == 'waiting_permission'
                  ? null
                  : _export,
              icon: const Icon(Icons.share),
              label: const Text('匯出診斷 NDJSON'),
            ),
            const Text('請先停止記錄再匯出；檔案包含精確位置，分享前請確認接收對象。'),
          ],
        ),
      ),
    );
  }

  Widget _detail(String label, String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Text('$label：$value'),
  );
}
