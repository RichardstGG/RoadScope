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
  Map<String, Object?> _status = const {};
  bool _reading = false;
  @override
  void initState() {
    super.initState();
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => _refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
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

  Future<void> _export() async {
    final path = _status['path'];
    if (path is! String || _status['state'] != 'idle') return;
    try {
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(path)],
          text: 'RoadScope motion v1 原始感測資料（不是定位紀錄）',
        ),
      );
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$error')));
      }
    }
  }

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
      const Text('傾角 — · 最大左傾 — · 最大右傾 —'),
      const Text('原始感測資料隨定位錄製；傾角估算與校準尚未啟用。'),
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
            ? _export
            : null,
        child: const Text('匯出 motion v1'),
      ),
      const Text('感測時鐘未驗證時，測量時間為空值，不能用於精準 GPS 對時。'),
    ],
  );
}
