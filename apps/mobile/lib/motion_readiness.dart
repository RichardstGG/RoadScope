import 'dart:async';

import 'package:device_bridge/device_bridge.dart';
import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';

/// Reads small native status snapshots; never loads the high-rate motion file.
class MotionReadiness extends StatefulWidget {
  const MotionReadiness({super.key});

  @override
  State<MotionReadiness> createState() => _MotionReadinessState();
}

class _MotionReadinessState extends State<MotionReadiness> {
  late final Future<Map<String, Object?>> _capabilities = const DeviceBridge()
      .motionCapabilities();
  Timer? _timer;
  StreamSubscription<Map<String, Object?>>? _updates;
  Map<String, Object?> _status = const {};
  bool _reading = false;
  @override
  void initState() {
    super.initState();
    _refresh();
    _updates = const DeviceBridge().motionUpdates.listen(
      (value) {
        if (mounted) setState(() => _status = value);
      },
      onError: (Object _) {
        /* iOS/older plugin: status remains explicit. */
      },
    );
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => _refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _updates?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    if (_reading) return;
    _reading = true;
    try {
      final status = await const DeviceBridge().motionStatus();
      if (mounted) setState(() => _status = status);
    } catch (_) {
      if (mounted) setState(() => _status = const {'state': 'unavailable'});
    } finally {
      _reading = false;
    }
  }

  Future<void> _export(String key) async {
    final path = _status[key];
    if (path is! String || _status['state'] != 'idle') return;
    try {
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(path)],
          text: key == 'path'
              ? 'RoadScope motion v1 原始感測資料'
              : 'RoadScope lean v1 實驗性傾角紀錄',
        ),
      );
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$error')));
      }
    }
  }

  bool _controlling = false;
  Future<void> _calibrate(String action) async {
    setState(() => _controlling = true);
    try {
      await const DeviceBridge().leanCalibration(action);
      await _refresh();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$error')));
      }
    } finally {
      if (mounted) setState(() => _controlling = false);
    }
  }

  String _angle(Object? value) =>
      value is num ? '${value.toStringAsFixed(1)}°' : '—';

  bool get _experimental =>
      _status['leanQualityMode'] == 'experimental_unverified_accelerometer' ||
      _status['leanQualityMode'] == 'experimental_unverified_calibration';

  String get _blockReason => switch (_status['leanBlockReason']) {
    'awaiting_inputs' => '等待各來源第一筆資料',
    'input_clock_not_verified' => '感測測量時鐘尚未驗證',
    'sensor_unavailable' => '缺少必要感測器',
    'sensor_accuracy_unreliable' => '感測器回報不可靠，已停止傾角估算與校準',
    'sensor_accuracy_unavailable' => '感測器未提供品質，已停止傾角估算與校準',
    'raw_write_failed' => '原始感測資料寫入失敗',
    'input_interrupted' => '感測輸入中斷，等待完整新輸入',
    'input_stale' => '傾角輸入已逾期，已隱藏舊角度',
    'recording_stopped' => '記錄已停止',
    null => _status['leanState'] == 'available' ? '無輸入阻擋' : '尚未取得診斷',
    _ => '未知原因：${_status['leanBlockReason']}',
  };

  String get _calibrationState => switch (_status['calibrationState']) {
    'collecting_upright' => '直立靜止收集中',
    'awaiting_left' => '直立完成，請安全左傾並確認',
    'collecting_left' => '左傾靜止收集中',
    'activating_manual' => '證據完成，等待下一筆測量生效',
    'calibrated' => '已校準',
    _ => '尚未啟動流程',
  };

  String get _automaticState => _status['state'] != 'recording'
      ? '未在採集，開始記錄後才收集候選'
      : _status['leanState'] == 'unavailable'
      ? '感測輸入未就緒，自動收集暫停'
      : _experimental
      ? '加速度品質未驗證，自動參考停用；僅允許停車手動校準'
      : switch (_status['autoReferenceState']) {
          'manual_priority' => '手動校準優先，自動參考不覆蓋',
          'manual_in_progress' => '手動校準進行中，自動收集暫停',
          'ready_axis_unknown' => '自動直立參考已建立；左右方向未知，請停車完成手動校準',
          'candidate_capacity_exceeded' => '候選方向過多，自動參考保持未知；請手動校準',
          'collecting' => '等待合格 GPS 與穩定直行，累積有效時間',
          _ => '尚未取得自動參考狀態',
        };

  String _available(Object? value) => switch (value) {
    true => '可用',
    false => '未提供',
    _ => '尚未驗證',
  };

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Divider(height: 32),
      Text('傾角開發診斷', style: Theme.of(context).textTheme.titleMedium),
      Text(
        '傾角 ${_angle(_status['leanAngleDeg'])} · 最大左傾 ${_angle(_experimental ? null : _status['maxLeft'])} · 最大右傾 ${_angle(_experimental ? null : _status['maxRight'])}',
      ),
      const Text('實驗性估算：負值左傾、正值右傾，尚未驗證道路準確度。品質不合格不計最大值。'),
      if (_experimental)
        const Text(
          '受限實驗模式：加速度目前或校準時回報不可靠。傾角只供停車操作檢查，精度未驗證；本模式不產生正式左右最大值或自動直立參考。',
        ),
      Text('校準：$_calibrationState · 品質：${_status['leanFlags'] ?? '—'}'),
      Text('傾角輸入：$_blockReason'),
      if (_status['leanBlockedSourceIds'] case final List ids)
        if (ids.isNotEmpty) Text('阻擋來源：${ids.join(', ')}'),
      if (_status['sensorAccuracy'] case final Map accuracy)
        Text('最近已存樣本的平台品質：$accuracy'),
      if (_status['leanBlockReason'] == 'sensor_accuracy_unreliable' ||
          _status['leanBlockReason'] == 'sensor_accuracy_unavailable')
        const Text(
          '直立校準只設定安裝參考，不能修復感測器品質。請先保持手機靜止檢查；若持續不可靠，停止並匯出診斷，不進行道路傾角驗收。',
        ),
      if (_status['calibrationProgress'] case final num progress)
        LinearProgressIndicator(value: progress.toDouble()),
      const Text(
        '僅停車且安全支撐時操作：保持車輛直立、前輪朝前，按直立並靜止 3 秒；再安全向左傾 5–25°，按左傾確認並靜止 3 秒。改變安裝或重開機／續錄後重新校準。',
      ),
      Text('自動參考：$_automaticState'),
      if (_status['autoReferenceDurationUs'] case final num duration)
        Text(
          '最久候選 ${(duration / 1000000).toStringAsFixed(1)} 秒（至少 30 秒且需明確優勢）',
        ),
      const Text('自動參考只建立直立基準，不猜測左右方向。請勿為取得參考刻意加速或在行進中操作校準。'),
      Wrap(
        spacing: 8,
        children: [
          OutlinedButton(
            onPressed:
                !_controlling &&
                    _status['state'] == 'recording' &&
                    _status['leanState'] == 'available'
                ? () => _calibrate('upright')
                : null,
            child: const Text('直立校準'),
          ),
          OutlinedButton(
            onPressed:
                !_controlling &&
                    _status['state'] == 'recording' &&
                    _status['leanState'] == 'available' &&
                    _status['calibrationState'] == 'awaiting_left'
                ? () => _calibrate('left')
                : null,
            child: const Text('左傾確認'),
          ),
          TextButton(
            onPressed: !_controlling && _status['state'] == 'recording'
                ? () => _calibrate('cancel')
                : null,
            child: const Text('取消校準流程'),
          ),
        ],
      ),
      Text('感測採集：${_status['state'] ?? '讀取中'}'),
      if (_status['counts'] case final Map counts) Text('已寫入樣本：$counts'),
      if (_status['clockStates'] case final Map clocks) Text('時鐘驗證：$clocks'),
      if (_status['error'] case final String error) Text('感測錯誤：$error'),
      FutureBuilder<Map<String, Object?>>(
        future: _capabilities,
        builder: (context, snapshot) {
          if (snapshot.hasError) return const Text('無法讀取感測器能力');
          final data = snapshot.data;
          if (data == null) return const Text('正在讀取感測器能力…');
          return Text(
            '加速度計：${_available(data['accelerometer'])}\n'
            '陀螺儀：${_available(data['gyroscope'])}\n'
            '旋轉向量：${_available(data['rotationVector'])}\n'
            '時間基準：${data['measurementClock'] ?? '尚未驗證'}',
          );
        },
      ),
      const Text(
        '固定於車把的手機會隨轉向改變姿態，可能增加傾角誤差；'
        '固定於車架通常較穩定。更動安裝位置後請重新校準。',
      ),
      OutlinedButton(
        onPressed: _status['state'] == 'idle' && _status['path'] is String
            ? () => _export('path')
            : null,
        child: const Text('匯出 motion v1'),
      ),
      OutlinedButton(
        onPressed: _status['state'] == 'idle' && _status['leanPath'] is String
            ? () => _export('leanPath')
            : null,
        child: const Text('匯出 lean v1'),
      ),
      const Text('感測時鐘未驗證時，測量時間為空值，不能用於精準 GPS 對時。'),
    ],
  );
}
