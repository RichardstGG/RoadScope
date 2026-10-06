import 'dart:async';

import 'package:device_bridge/device_bridge.dart';
import 'package:flutter/material.dart';
import 'package:mobile_data/mobile_data.dart';
import 'package:share_plus/share_plus.dart';

import 'motion_readiness.dart';

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
  TelemetryReadReport? _telemetry;
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
      // Separate file, separate reader: telemetry never enters the log import.
      final telemetry = await _bridge.telemetry();
      if (!mounted) return;
      setState(() {
        _status = status;
        _report = report;
        _telemetry = telemetry;
        _latest = samples.isEmpty ? null : samples.last;
        _error = null;
      });
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      _polling = false;
    }
  }

  Future<void> _runRecorderAction(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
      await _refresh();
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _toggle() => _runRecorderAction(
    _status?.isRecording == true || _status?.state == 'waiting_permission'
        ? _bridge.stop
        : _bridge.start,
  );

  Future<void> _resume() => _runRecorderAction(_bridge.start);

  Future<void> _finishInterrupted() => _runRecorderAction(_bridge.stop);

  /// Each format is exported on its own, with its own wording, so a receiver
  /// can never mistake diagnostics telemetry for a location-log v1 file.
  Future<void> _export(String? path, String text) async {
    if (path == null) return;
    try {
      await SharePlus.instance.share(
        ShareParams(files: [XFile(path)], text: text),
      );
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  Future<void> _openSettings(Future<void> Function() open) async {
    try {
      await open();
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  String _stateLabel(String? state) => switch (state) {
    'recording' => '記錄中',
    'resuming' => '正在恢復記錄',
    'interrupted' => '記錄已中斷',
    'waiting_permission' => '等待定位授權',
    'error' => '記錄錯誤',
    'idle' => '未記錄',
    _ => '讀取中',
  };

  String _number(double? value, String unit, {int digits = 1}) =>
      value == null ? '無效／未提供' : '${value.toStringAsFixed(digits)} $unit';

  /// `null` is never shown as `false`: an unobservable state reads
  /// "無法取得（not available）", and an enum the platform reported as unknown
  /// reads "未知（unknown）".
  String _flag(bool? value, String yes, String no) =>
      value == null ? '無法取得（not available）' : (value ? yes : no);

  String _enumLabel(String? value, Map<String, String> labels) {
    if (value == null || value.isEmpty) return '無法取得（not available）';
    if (value == 'unknown') return '未知（unknown）';
    return labels[value] ?? '$value（未知值）';
  }

  String _vendorGuidance(String? manufacturer) {
    final vendor = manufacturer?.toLowerCase() ?? '';
    if (vendor.contains('xiaomi') ||
        vendor.contains('redmi') ||
        vendor.contains('poco')) {
      return '請在小米系統設定中允許自啟動，並將電池用量設為無限制。'
          '自啟動是廠商私有設定，App 無法可靠讀取是否已開啟。';
    }
    if (vendor.contains('oppo') ||
        vendor.contains('oneplus') ||
        vendor.contains('realme')) {
      return '請允許自動啟動／關聯啟動，並將電池用量設為允許背景活動。'
          '這些廠商設定無法由 App 可靠讀取。';
    }
    if (vendor.contains('vivo') || vendor.contains('iqoo')) {
      return '請在背景耗電管理與自啟動管理中允許 RoadScope。'
          '這些廠商設定無法由 App 可靠讀取。';
    }
    if (vendor.contains('huawei') || vendor.contains('honor')) {
      return '請在應用程式啟動管理中改為手動管理，允許自動啟動與背景執行。'
          '這些廠商設定無法由 App 可靠讀取。';
    }
    return '請確認系統允許 RoadScope 在背景執行。';
  }

  List<Widget> _backgroundExecutionSection(BuildContext context) {
    final status = _status;
    if (status?.platform != 'android') return const [];
    final notificationGranted = status?.notificationPermissionGranted;
    final batteryIgnored = status?.batteryOptimizationIgnored;
    final needsAttention =
        notificationGranted != true ||
        batteryIgnored != true ||
        status?.vendorBackgroundSetupRecommended == true;
    return [
      const Divider(height: 32),
      Text('Android 背景執行準備', style: Theme.of(context).textTheme.titleMedium),
      _detail('裝置廠牌', status?.manufacturer ?? '未知（unknown）'),
      _detail('常駐通知權限', _flag(notificationGranted, '已允許', '未允許')),
      _detail('電池最佳化', _flag(batteryIgnored, '已排除', '仍受限制')),
      if (needsAttention)
        Text(
          '長時間測試前請完成下列設定。通知被拒絕不會阻止開始記錄，'
          '但使用者看不到常駐通知，背景採集證據也會缺少重要條件。',
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
      if (status?.vendorBackgroundSetupRecommended == true)
        Text(_vendorGuidance(status?.manufacturer)),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          OutlinedButton(
            onPressed: () => _openSettings(_bridge.openAppSettings),
            child: const Text('開啟 App 權限設定'),
          ),
          OutlinedButton(
            onPressed: () =>
                _openSettings(_bridge.openBatteryOptimizationSettings),
            child: const Text('開啟電池最佳化設定'),
          ),
        ],
      ),
      const Text('返回 RoadScope 後會重新讀取公開狀態；廠商自啟動開關仍需人工確認。'),
    ];
  }

  List<Widget> _telemetrySection(BuildContext context) {
    final report = _telemetry;
    final record = report?.latest;
    final telemetryPath = _status?.telemetryPath;
    final exportable =
        telemetryPath != null && (report?.records.isNotEmpty ?? false);
    return [
      const Divider(height: 32),
      Text(
        '診斷 telemetry（非 location-log v1）',
        style: Theme.of(context).textTheme.titleMedium,
      ),
      if (record == null)
        const Text('尚無 telemetry 紀錄；開始記錄後才會寫入。')
      else ...[
        _detail(
          '電量',
          record.batteryPercent == null
              ? '無法取得（not available）'
              : '${record.batteryPercent}%',
        ),
        _detail('充電狀態', _flag(record.batteryCharging, '充電中', '未充電')),
        _detail(
          '電源來源',
          _enumLabel(record.batteryPowerSource, const {
            'ac': '市電',
            'usb': 'USB',
            'wireless': '無線充電',
            'dock': '底座',
            'none': '未接外部電源',
          }),
        ),
        _detail('省電模式', _flag(record.powerSaveMode, '開啟', '關閉')),
        _detail(
          'App 狀態',
          _enumLabel(record.appLifecycle, const {
            'foreground': '前景',
            'inactive': '前景但未接受輸入',
            'background': '背景',
          }),
        ),
        _detail('螢幕可互動', _flag(record.screenInteractive, '是', '否')),
        _detail('keyguard 狀態', _flag(record.keyguardLocked, '已上鎖', '未上鎖')),
        _detail(
          'iOS 保護資料可用',
          _flag(record.protectedDataAvailable, '可用', '不可用'),
        ),
        _detail('螢幕狀態來源', record.screenStateSource),
        _detail(
          '定位服務狀態',
          _enumLabel(record.locationServiceState, const {
            'started': '已啟動',
            'stopped': '已停止',
            'restarted': '已重建',
            'failed': '失敗',
          }),
        ),
        if (record.locationServiceDetail != null)
          _detail('定位服務說明', record.locationServiceDetail!),
        _detail('程序重啟次數', '${record.processRestartCount}'),
        _detail(
          '恢復原因',
          record.resumeReason == null
              ? '本次非恢復'
              : _enumLabel(record.resumeReason, const {
                  'process_restart': '程序重啟',
                  'crash': '崩潰後恢復',
                  'boot': '重開機後恢復',
                }),
        ),
        _detail(
          'telemetry 時間（UTC）',
          record.occurredAtUtc?.toIso8601String() ?? '無法取得（not available）',
        ),
        _detail(
          'telemetry 單調時間',
          record.occurredMonotonicUs == null
              ? '無法取得（not available）'
              : '${record.occurredMonotonicUs} µs',
        ),
        _detail('對應的最後定位序號', '${record.locationLogLastSequence}'),
        _detail(
          '觸發原因',
          _enumLabel(record.trigger, const {
            'recording_started': '開始記錄',
            'recording_resumed': '續錄',
            'recording_stopped': '停止記錄',
            'recording_interrupted': '上一段非正常結束',
            'location_service': '定位服務變化',
            'task_removed': '近期工作清單已移除',
            'state_change': '狀態改變',
            'heartbeat': '定期回報',
          }),
        ),
        _detail(
          'telemetry 筆數／壞行',
          '${report!.records.length}／${report.badLines}',
        ),
        if (record.unavailable.isNotEmpty)
          _detail('無法取得的欄位', record.unavailable.join('、')),
      ],
      _detail('telemetry 可匯出', exportable ? '可匯出' : '目前不可匯出'),
      // An abrupt end with no marker is still possible, so this warning only
      // fires when the writer managed to record one.
      if (report?.lastSegmentInterrupted ?? false)
        Text(
          '上一段記錄沒有自己收尾（程序被終止、崩潰或斷電）。'
          '定位紀錄寫到序號 ${record!.locationLogLastSequence} 為止。',
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
      const Text('telemetry 是事後判讀用的診斷資訊，不證明背景採集穩定。'),
    ];
  }

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
    final stopped =
        status?.isRecording != true &&
        status?.state != 'waiting_permission' &&
        status?.state != 'interrupted';
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
            if (status?.state == 'interrupted') ...[
              Text(
                '上一段原生採集已停止。你可以接續同一筆記錄，或結束後匯出；'
                'App 不會只因重新開啟或裝置重開機就自動恢復定位。',
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
              const SizedBox(height: 12),
            ],
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
            if (status?.state == 'interrupted') ...[
              FilledButton.icon(
                onPressed: _busy ? null : _resume,
                icon: const Icon(Icons.play_arrow),
                label: const Text('繼續同一次記錄'),
              ),
              OutlinedButton.icon(
                onPressed: _busy ? null : _finishInterrupted,
                icon: const Icon(Icons.stop),
                label: const Text('結束這次記錄'),
              ),
            ] else
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
              onPressed: _busy || !stopped || status?.logPath == null
                  ? null
                  : () => _export(
                      status!.logPath,
                      'RoadScope location-log v1 定位紀錄；包含精確位置，請只分享給信任的接收者。',
                    ),
              icon: const Icon(Icons.share),
              label: const Text('匯出 location-log v1'),
            ),
            OutlinedButton.icon(
              onPressed:
                  _busy ||
                      !stopped ||
                      status?.telemetryPath == null ||
                      (_telemetry?.records.isEmpty ?? true)
                  ? null
                  : () => _export(
                      status!.telemetryPath,
                      'RoadScope diagnostics telemetry；裝置與 App 狀態診斷，不含位置資料。',
                    ),
              icon: const Icon(Icons.share_outlined),
              label: const Text('匯出 diagnostics telemetry'),
            ),
            const Text(
              '請先停止記錄再匯出。兩個檔案分開匯出：location-log v1 含精確位置，'
              'diagnostics telemetry 只含裝置與 App 狀態。',
            ),
            ..._backgroundExecutionSection(context),
            const MotionReadiness(),
            ..._telemetrySection(context),
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
