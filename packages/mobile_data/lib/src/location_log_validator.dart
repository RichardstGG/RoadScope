import 'dart:convert';

const _warnings = {
  'SEQUENCE_GAP',
  'BOOT_ID_CHANGE_UNDECLARED',
  'SOURCE_TYPE_DEPRECATED',
  'UNKNOWN_QUALITY_FLAG',
  'UNKNOWN_RECORD_TYPE',
  'UNKNOWN_EVENT_TYPE',
  'MISSING_RECORDING_STARTED',
};
const _pairs = {
  'speedMps': 'speed_unavailable',
  'headingDeg': 'heading_unavailable',
  'horizontalAccuracyM': 'horizontal_accuracy_unavailable',
  'speedAccuracyMps': 'speed_accuracy_unavailable',
  'altitudeM': 'altitude_unavailable',
  'measurementMonotonicUs': 'measurement_monotonic_unavailable',
};
const _sourceTypes = {'phone_location', 'external_gnss', 'phone_gnss'};
const _sampleKeys = {
  'schemaVersion',
  'recordType',
  'recordingId',
  'sourceId',
  'sourceType',
  'deviceBootId',
  'sequence',
  'measuredAtUtc',
  'receivedAtUtc',
  'measurementMonotonicUs',
  'receivedMonotonicUs',
  'latDeg',
  'lonDeg',
  'altitudeM',
  'speedMps',
  'headingDeg',
  'horizontalAccuracyM',
  'speedAccuracyMps',
  'qualityFlags',
};
const _eventKeys = {
  'schemaVersion',
  'recordType',
  'eventType',
  'recordingId',
  'sourceId',
  'deviceBootId',
  'occurredAtUtc',
  'occurredMonotonicUs',
  'lastSequence',
};
const _eventExtra = {
  'recording_started': {
    'platform',
    'appVersion',
    'sourceType',
    'sourceCapabilities',
    'bootAnchorUtcMs',
  },
  'clock_adjusted': {
    'previousDeviceBootId',
    'previousBootAnchorUtcMs',
    'bootAnchorUtcMs',
    'thresholdMs',
  },
  'log_truncated': {'truncatedBytes', 'resumedSequence'},
  'recording_resumed': {'reason', 'resumedSequence'},
};

class LogFinding {
  const LogFinding(this.code, this.line);
  final String code;
  final int line;
  bool get isError => !_warnings.contains(code);
  @override
  String toString() => '${isError ? 'E' : 'W'} line $line $code';
}

bool _string(Object? v) => v is String && v.isNotEmpty;
bool _integer(Object? v, [int? min]) =>
    v is num &&
    v.isFinite &&
    v == v.roundToDouble() &&
    (min == null || v >= min);
bool _number(Object? v, [double? min, double? max]) =>
    v is num &&
    v.isFinite &&
    (min == null || v >= min) &&
    (max == null || v <= max);
bool _utc(Object? v) =>
    v is String &&
    RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$').hasMatch(v);
bool _keys(Map<String, Object?> r, Set<String> keys) =>
    keys.every(r.containsKey) && r.keys.every(keys.contains);
bool _identity(Map<String, Object?> r) =>
    ['recordingId', 'sourceId', 'deviceBootId'].every((key) => _string(r[key]));

List<LogFinding> validateSampleFields(Map<String, Object?> r, int line) {
  final result = <LogFinding>[];
  final flags = r['qualityFlags'];
  if (flags is List) {
    for (final pair in _pairs.entries) {
      if (r.containsKey(pair.key) &&
          ((r[pair.key] == null) != flags.contains(pair.value))) {
        result.add(LogFinding('NULL_FLAG_MISMATCH', line));
      }
    }
  }
  bool nullable(String key, bool Function(Object?) check) =>
      r[key] == null || check(r[key]);
  if (!_keys(r, _sampleKeys) ||
      r['schemaVersion'] != 1 ||
      r['recordType'] != 'sample' ||
      !_identity(r) ||
      !_sourceTypes.contains(r['sourceType']) ||
      !_integer(r['sequence'], 0) ||
      !_utc(r['measuredAtUtc']) ||
      !_utc(r['receivedAtUtc']) ||
      !_integer(r['receivedMonotonicUs'], 0) ||
      !nullable('measurementMonotonicUs', (v) => _integer(v, 0)) ||
      !_number(r['latDeg'], -90, 90) ||
      !_number(r['lonDeg'], -180, 180) ||
      !nullable('altitudeM', _number) ||
      !nullable('speedMps', (v) => _number(v, 0)) ||
      !nullable('headingDeg', (v) => _number(v, 0) && (v as num) < 360) ||
      !nullable('horizontalAccuracyM', (v) => _number(v, 0)) ||
      !nullable('speedAccuracyMps', (v) => _number(v, 0)) ||
      flags is! List ||
      flags.toSet().length != flags.length ||
      flags.any(
        (v) => v is! String || !RegExp(r'^[a-z][a-z0-9_]*$').hasMatch(v),
      )) {
    result.add(LogFinding('SCHEMA_INVALID', line));
  }
  return result;
}

bool _validEvent(Map<String, Object?> r) {
  if (!_eventKeys.every(r.containsKey) ||
      r['schemaVersion'] != 1 ||
      !_identity(r) ||
      r['eventType'] is! String ||
      !_utc(r['occurredAtUtc']) ||
      !_integer(r['occurredMonotonicUs'], 0) ||
      !_integer(r['lastSequence'], -1)) {
    return false;
  }
  final extra = _eventExtra[r['eventType']];
  if (extra == null) return true;
  if (!_keys(r, {..._eventKeys, ...extra})) return false;
  switch (r['eventType']) {
    case 'recording_started':
      final caps = r['sourceCapabilities'];
      return {'android', 'ios'}.contains(r['platform']) &&
          _string(r['appVersion']) &&
          _sourceTypes.contains(r['sourceType']) &&
          _integer(r['bootAnchorUtcMs']) &&
          caps is Map &&
          caps.length == 2 &&
          caps['measurementMonotonic'] is bool &&
          caps['monotonicIncludesSleep'] is bool;
    case 'clock_adjusted':
      return _string(r['previousDeviceBootId']) &&
          _integer(r['previousBootAnchorUtcMs']) &&
          _integer(r['bootAnchorUtcMs']) &&
          _integer(r['thresholdMs'], 1);
    case 'log_truncated':
      return _integer(r['truncatedBytes'], 1) &&
          _integer(r['resumedSequence'], 0);
    case 'recording_resumed':
      return {'crash', 'process_restart', 'boot'}.contains(r['reason']) &&
          _integer(r['resumedSequence'], 0);
  }
  return false;
}

class ValidatedLog {
  final findings = <LogFinding>[];
  final samples = <Map<String, Object?>>[];
  final sampleLines = <int>[];

  /// Original text, including unknown record/event values, is retained for export.
  final events = <String>[];
  final unknownRecords = <String>[];
  bool get ok => !findings.any((f) => f.isError);
}

class _Stream {
  final samples = <num, String>{};
  num maxSequence = -1;
  num? expectedNext;
  String? lastBoot;
  bool declared = false, started = false;
  final received = <String, num>{};
  final measured = <String, num>{};
}

String canonicalRecord(Object? value) {
  if (value is Map) {
    final keys = value.keys.cast<String>().toList()..sort();
    return '{${keys.map((k) => '${jsonEncode(k)}:${canonicalRecord(value[k])}').join(',')}}';
  }
  if (value is List) return '[${value.map(canonicalRecord).join(',')}]';
  if (value is num && value.isFinite && value == value.roundToDouble()) {
    return value.toInt().toString();
  }
  return jsonEncode(value);
}

/// Validates one complete file. Cross-import deduplication belongs to the importer.
ValidatedLog validateLocationLog(String text) {
  final result = ValidatedLog();
  final streams = <String, _Stream>{};
  final lines = text.split('\n');
  for (var index = 0; index < lines.length; index++) {
    final raw = lines[index];
    if (raw.trim().isEmpty) continue;
    final line = index + 1;
    void add(String code) => result.findings.add(LogFinding(code, line));
    Map<String, Object?> r;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) {
        add('NOT_JSON');
        continue;
      }
      r = decoded;
    } on FormatException {
      add('NOT_JSON');
      continue;
    }
    if (!r.containsKey('recordType')) {
      add('MISSING_RECORD_TYPE');
      continue;
    }
    if (r['recordType'] != 'sample' && r['recordType'] != 'event') {
      result.unknownRecords.add(raw);
      add('UNKNOWN_RECORD_TYPE');
      continue;
    }
    if (r['recordType'] == 'sample') {
      final findings = validateSampleFields(r, line);
      result.findings.addAll(findings);
      if (findings.isNotEmpty) continue;
    } else if (!_validEvent(r)) {
      add('SCHEMA_INVALID');
      continue;
    }
    final key = '${r['recordingId']}\u0000${r['sourceId']}';
    final stream = streams.putIfAbsent(key, _Stream.new);
    final boot = r['deviceBootId'] as String;
    if (r['recordType'] == 'event') {
      result.events.add(raw);
      final type = r['eventType'];
      if (!_eventExtra.containsKey(type)) add('UNKNOWN_EVENT_TYPE');
      if (type == 'recording_started') stream.started = true;
      if ((r['lastSequence'] as num) > stream.maxSequence) {
        add('EVENT_SEQUENCE_AHEAD');
      }
      if (type == 'log_truncated' || type == 'recording_resumed') {
        stream.expectedNext = r['resumedSequence'] as num;
      }
      if (type == 'clock_adjusted' || type == 'recording_resumed') {
        stream.declared = true;
      }
      stream.lastBoot = boot;
      continue;
    }
    result.samples.add(r);
    result.sampleLines.add(line);
    if (!stream.started) {
      add('MISSING_RECORDING_STARTED');
      stream.started = true;
    }
    if (r['sourceType'] == 'phone_gnss') add('SOURCE_TYPE_DEPRECATED');
    for (final flag in r['qualityFlags'] as List) {
      if (!_pairs.containsValue(flag) && flag != 'synthetic') {
        add('UNKNOWN_QUALITY_FLAG');
      }
    }
    final sequence = r['sequence'] as num;
    final canonical = canonicalRecord(r);
    if (stream.samples.containsKey(sequence)) {
      add(
        stream.samples[sequence] == canonical
            ? 'SEQUENCE_DUPLICATE'
            : 'SEQUENCE_CONFLICT',
      );
    } else {
      stream.samples[sequence] = canonical;
    }
    if (stream.expectedNext != null && sequence > stream.expectedNext!) {
      add('SEQUENCE_GAP');
    }
    if (sequence + 1 > (stream.expectedNext ?? 0)) {
      stream.expectedNext = sequence + 1;
    }
    if (sequence > stream.maxSequence) stream.maxSequence = sequence;
    if (stream.lastBoot != null && stream.lastBoot != boot) {
      if (!stream.declared) add('BOOT_ID_CHANGE_UNDECLARED');
      stream.declared = false;
    }
    stream.lastBoot = boot;
    void monotonic(Map<String, num> values, Object? value, String code) {
      if (value is! num) return;
      if (values[boot] != null && value < values[boot]!) {
        add(code);
      }
      values[boot] = value;
    }

    monotonic(
      stream.received,
      r['receivedMonotonicUs'],
      'MONOTONIC_REGRESSION',
    );
    monotonic(
      stream.measured,
      r['measurementMonotonicUs'],
      'MEASUREMENT_MONOTONIC_REGRESSION',
    );
  }
  return result;
}
