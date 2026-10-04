import 'dart:convert';

/// Reader for the app-local diagnostics telemetry log.
///
/// This log is **not** `contracts/location-log/v1`. It is a separate file with
/// its own [telemetryVersion] and its own sequence space, written so that a
/// recording can be interpreted afterwards: battery, charging, observable
/// screen state, app foreground state and location service transitions.
///
/// It carries no position data, and it is not evidence that background
/// collection is stable. Reading it tells you what the OS reported while the
/// app was running, nothing more.
const diagnosticsTelemetryVersion = 1;

/// The only `recordType` this reader understands. Anything else is treated as
/// a newer writer and preserved rather than discarded.
const diagnosticsTelemetryRecordType = 'diagnostics_telemetry';

const _knownTriggers = {
  'recording_started',
  'recording_resumed',
  'recording_stopped',
  diagnosticsTelemetryInterruptedTrigger,
  'location_service',
  diagnosticsTelemetryTaskRemovedTrigger,
  'state_change',
  'heartbeat',
};

/// A segment that ended without writing its own closing row, noticed
/// afterwards by a later process.
///
/// Its timestamps are **when the interruption was noticed**, not when it
/// happened; the real end is bounded by [DiagnosticsTelemetryRecord
/// .locationLogLastSequence] and the previous row's time. Its device
/// observables are deliberately unavailable, because the writer does not know
/// what the device looked like when the segment died.
const diagnosticsTelemetryInterruptedTrigger = 'recording_interrupted';

/// Android removed the app task from Recents while the recorder service was
/// still alive. iOS has no equivalent event.
const diagnosticsTelemetryTaskRemovedTrigger = 'task_removed';

const _knownLifecycles = {'foreground', 'inactive', 'background', 'unknown'};

const _knownServiceStates = {
  'started',
  'stopped',
  'restarted',
  'failed',
  'unknown',
};

const _knownPowerSources = {'ac', 'usb', 'wireless', 'dock', 'none', 'unknown'};

const _knownFlags = {
  'battery_percent_unavailable',
  'battery_charging_unavailable',
  'battery_power_source_unknown',
  'power_save_mode_unavailable',
  'screen_interactive_unavailable',
  'keyguard_state_unavailable',
  'protected_data_state_unavailable',
  'app_lifecycle_unknown',
  'location_service_state_unknown',
  'device_boot_id_unavailable',
  'utc_time_unavailable',
  'monotonic_time_unavailable',
};

/// Every field name a telemetry row may carry.
///
/// The Kotlin and Swift writers are checked against this set, so a field added
/// on one platform cannot quietly go missing on the other or on the reader.
const diagnosticsTelemetryFields = {
  'telemetryVersion',
  'recordType',
  'recordingId',
  'sourceId',
  'platform',
  'appVersion',
  'deviceBootId',
  'telemetrySequence',
  'trigger',
  'reasons',
  'occurredAtUtc',
  'occurredMonotonicUs',
  'locationLogLastSequence',
  'batteryPercent',
  'batteryCharging',
  'batteryPowerSource',
  'powerSaveMode',
  'screenInteractive',
  'keyguardLocked',
  'protectedDataAvailable',
  'screenStateSource',
  'appLifecycle',
  'locationServiceState',
  'locationServiceDetail',
  'processRestartCount',
  'resumeReason',
  'recoveredTruncatedBytes',
  'unavailable',
};

/// Keys that must never appear: telemetry is not allowed to carry position
/// data, so a file containing any of them is rejected rather than displayed.
const _forbiddenFields = {
  'latDeg',
  'lonDeg',
  'altitudeM',
  'speedMps',
  'headingDeg',
  'horizontalAccuracyM',
  'speedAccuracyMps',
};

/// Nullable value fields paired with the flag that must accompany a `null`.
const _nullFlags = {
  'batteryPercent': 'battery_percent_unavailable',
  'batteryCharging': 'battery_charging_unavailable',
  'powerSaveMode': 'power_save_mode_unavailable',
  'screenInteractive': 'screen_interactive_unavailable',
  'keyguardLocked': 'keyguard_state_unavailable',
  'protectedDataAvailable': 'protected_data_state_unavailable',
  'deviceBootId': 'device_boot_id_unavailable',
  'occurredAtUtc': 'utc_time_unavailable',
  'occurredMonotonicUs': 'monotonic_time_unavailable',
};

/// One problem found while reading a telemetry file.
///
/// Errors mean the file cannot be trusted. Warnings are cases the format
/// deliberately tolerates, such as a newer writer's unknown trigger: failing
/// on those would throw away a whole diagnostics file for being too new.
class TelemetryFinding {
  const TelemetryFinding(this.code, this.line);

  final String code;
  final int line;

  static const errorCodes = {
    'NOT_JSON',
    'NOT_AN_OBJECT',
    'MISSING_RECORD_TYPE',
    'MISSING_TELEMETRY_VERSION',
    'FIELD_TYPE_INVALID',
    'FIELD_VALUE_OUT_OF_RANGE',
    'NULL_FLAG_MISMATCH',
    'SEQUENCE_DUPLICATE',
    'POSITION_FIELD_PRESENT',
  };

  bool get isError => errorCodes.contains(code);

  @override
  String toString() => '$code@$line';
}

/// A single telemetry row. Every observable is nullable, because "the platform
/// did not tell us" is a real and common answer that must not be shown as
/// `false`.
class DiagnosticsTelemetryRecord {
  const DiagnosticsTelemetryRecord({
    required this.telemetryVersion,
    required this.recordingId,
    required this.sourceId,
    required this.platform,
    required this.appVersion,
    required this.telemetrySequence,
    required this.trigger,
    required this.reasons,
    required this.locationLogLastSequence,
    required this.batteryPowerSource,
    required this.screenStateSource,
    required this.appLifecycle,
    required this.locationServiceState,
    required this.processRestartCount,
    required this.unavailable,
    this.deviceBootId,
    this.occurredAtUtc,
    this.occurredMonotonicUs,
    this.batteryPercent,
    this.batteryCharging,
    this.powerSaveMode,
    this.screenInteractive,
    this.keyguardLocked,
    this.protectedDataAvailable,
    this.locationServiceDetail,
    this.resumeReason,
    this.recoveredTruncatedBytes,
  });

  final int telemetryVersion;
  final String recordingId;
  final String sourceId;
  final String platform;
  final String appVersion;
  final String? deviceBootId;
  final int telemetrySequence;
  final String trigger;
  final List<String> reasons;

  /// Wall clock and monotonic time of the observation. Either can be `null`
  /// when the platform did not provide a usable value; the matching
  /// `*_unavailable` flag then appears in [unavailable].
  final DateTime? occurredAtUtc;
  final int? occurredMonotonicUs;

  /// Last `location-log` sample sequence written when this row was recorded,
  /// `-1` before the first sample. Read-only: telemetry never changes the
  /// location log's own sequence rules.
  final int locationLogLastSequence;

  final int? batteryPercent;
  final bool? batteryCharging;
  final String batteryPowerSource;
  final bool? powerSaveMode;

  /// Android `PowerManager.isInteractive()`. `null` on iOS, which has no
  /// public equivalent.
  final bool? screenInteractive;

  /// Android `KeyguardManager.isKeyguardLocked()`. This is the keyguard state,
  /// not a precise "user sees a lock screen" event, and it is `null` on iOS.
  final bool? keyguardLocked;

  /// iOS `UIApplication.isProtectedDataAvailable`. `false` means protected
  /// files are unavailable, which usually follows a lock; `true` does **not**
  /// prove the device is unlocked. `null` on Android.
  final bool? protectedDataAvailable;

  /// Names the APIs the screen fields came from, so a reader never has to
  /// guess whether a platform limitation or a real state produced a `null`.
  final String screenStateSource;

  final String appLifecycle;
  final String locationServiceState;
  final String? locationServiceDetail;
  final int processRestartCount;
  final String? resumeReason;

  /// Bytes dropped while repairing an incomplete tail before this row, or
  /// `null` when nothing was repaired. A `null` here means "nothing to
  /// report", so it needs no flag.
  final int? recoveredTruncatedBytes;

  final List<String> unavailable;

  bool get hasUnknownScreenState => screenInteractive == null;
}

/// Outcome of reading one telemetry file.
class TelemetryReadReport {
  const TelemetryReadReport({
    required this.records,
    required this.findings,
    required this.unknownRecordTypes,
    required this.unknownFields,
    required this.badLines,
  });

  final List<DiagnosticsTelemetryRecord> records;
  final List<TelemetryFinding> findings;

  /// Rows from a newer writer, preserved verbatim and counted.
  final List<String> unknownRecordTypes;

  /// Field names this reader does not know, so a newer writer's extra data is
  /// visible instead of silently dropped.
  final Set<String> unknownFields;

  /// Distinct lines that produced an error.
  final int badLines;

  bool get ok => !findings.any((finding) => finding.isError);

  DiagnosticsTelemetryRecord? get latest =>
      records.isEmpty ? null : records.last;

  /// Whether the last segment in this file ended without closing itself —
  /// a process kill, a crash, or a power cut. `false` only means no such row
  /// was written: a segment whose app was never opened again cannot be marked
  /// at all, so an abrupt end with no marker is still possible.
  bool get lastSegmentInterrupted =>
      latest?.trigger == diagnosticsTelemetryInterruptedTrigger;
}

/// Parses a whole telemetry file. Safe to call repeatedly on a growing file.
///
/// A file truncated mid-line by a crash or a power cut is expected: the
/// incomplete tail is reported as a warning and the rest is still returned.
TelemetryReadReport parseDiagnosticsTelemetry(String ndjson) {
  final records = <DiagnosticsTelemetryRecord>[];
  final findings = <TelemetryFinding>[];
  final unknownRecordTypes = <String>[];
  final unknownFields = <String>{};
  final seen = <int>{};

  final lines = LineSplitter.split(ndjson).toList();
  final endsWithNewline = ndjson.isEmpty || ndjson.endsWith('\n');
  var previousSequence = -1;

  for (var index = 0; index < lines.length; index++) {
    final line = lines[index];
    final number = index + 1;
    if (line.trim().isEmpty) continue;
    final isTail = index == lines.length - 1 && !endsWithNewline;

    Object? decoded;
    try {
      decoded = jsonDecode(line);
    } catch (_) {
      // An unterminated final line is a crash artefact, not corruption.
      findings.add(
        TelemetryFinding(isTail ? 'INCOMPLETE_TAIL_LINE' : 'NOT_JSON', number),
      );
      continue;
    }
    if (decoded is! Map<String, Object?>) {
      findings.add(TelemetryFinding('NOT_AN_OBJECT', number));
      continue;
    }

    final forbidden = _forbiddenFields.where(decoded.containsKey);
    if (forbidden.isNotEmpty) {
      findings.add(TelemetryFinding('POSITION_FIELD_PRESENT', number));
      continue;
    }

    final recordType = decoded['recordType'];
    if (recordType is! String) {
      findings.add(TelemetryFinding('MISSING_RECORD_TYPE', number));
      continue;
    }
    if (recordType != diagnosticsTelemetryRecordType) {
      findings.add(TelemetryFinding('UNKNOWN_RECORD_TYPE', number));
      unknownRecordTypes.add(line);
      continue;
    }

    final version = decoded['telemetryVersion'];
    if (version is! int) {
      findings.add(TelemetryFinding('MISSING_TELEMETRY_VERSION', number));
      continue;
    }
    if (version > diagnosticsTelemetryVersion) {
      findings.add(TelemetryFinding('NEWER_TELEMETRY_VERSION', number));
    }

    unknownFields.addAll(
      decoded.keys.where((key) => !diagnosticsTelemetryFields.contains(key)),
    );

    final flags = decoded['unavailable'];
    if (flags is! List || flags.any((flag) => flag is! String)) {
      findings.add(TelemetryFinding('FIELD_TYPE_INVALID', number));
      continue;
    }
    final unavailable = flags.cast<String>().toList();
    for (final flag in unavailable) {
      if (!_knownFlags.contains(flag)) {
        findings.add(TelemetryFinding('UNKNOWN_FLAG', number));
      }
    }

    // null and its flag must agree in both directions, like the location log's
    // quality flags. A value shown without its flag, or a flag without a null,
    // means the writer and the reader disagree about what is known.
    var mismatched = false;
    for (final entry in _nullFlags.entries) {
      final isNull = decoded[entry.key] == null;
      if (isNull != unavailable.contains(entry.value)) mismatched = true;
    }
    if (mismatched) {
      findings.add(TelemetryFinding('NULL_FLAG_MISMATCH', number));
      continue;
    }

    final record = _read(decoded, number, findings, unavailable);
    if (record == null) continue;

    if (!seen.add(record.telemetrySequence)) {
      findings.add(TelemetryFinding('SEQUENCE_DUPLICATE', number));
      continue;
    }
    if (previousSequence >= 0 &&
        record.telemetrySequence > previousSequence + 1) {
      findings.add(TelemetryFinding('TELEMETRY_SEQUENCE_GAP', number));
    }
    previousSequence = record.telemetrySequence;
    records.add(record);
  }

  return TelemetryReadReport(
    records: List.unmodifiable(records),
    findings: List.unmodifiable(findings),
    unknownRecordTypes: List.unmodifiable(unknownRecordTypes),
    unknownFields: Set.unmodifiable(unknownFields),
    badLines: findings
        .where((finding) => finding.isError)
        .map((finding) => finding.line)
        .toSet()
        .length,
  );
}

DiagnosticsTelemetryRecord? _read(
  Map<String, Object?> row,
  int line,
  List<TelemetryFinding> findings,
  List<String> unavailable,
) {
  var invalid = false;
  var outOfRange = false;

  T? typed<T>(String key) {
    final value = row[key];
    if (value is T) return value;
    if (value != null) invalid = true;
    return null;
  }

  String required(String key) {
    final value = row[key];
    if (value is! String || value.isEmpty) {
      invalid = true;
      return '';
    }
    return value;
  }

  int requiredInt(String key, {int min = 0}) {
    final value = row[key];
    if (value is! int) {
      invalid = true;
      return min;
    }
    if (value < min) outOfRange = true;
    return value;
  }

  String enumerated(String key, Set<String> allowed) {
    final value = required(key);
    if (value.isNotEmpty && !allowed.contains(value)) {
      findings.add(TelemetryFinding('UNKNOWN_ENUM_VALUE', line));
    }
    return value;
  }

  final reasons = row['reasons'];
  if (reasons is! List || reasons.any((reason) => reason is! String)) {
    invalid = true;
  }

  final percent = typed<int>('batteryPercent');
  if (percent != null && (percent < 0 || percent > 100)) outOfRange = true;

  final occurredAtUtc = typed<String>('occurredAtUtc');
  DateTime? timestamp;
  if (occurredAtUtc != null) {
    if (!occurredAtUtc.endsWith('Z')) {
      // Local offsets would make every reader normalise differently.
      invalid = true;
    } else {
      timestamp = DateTime.tryParse(occurredAtUtc)?.toUtc();
      if (timestamp == null) invalid = true;
    }
  }

  final trigger = enumerated('trigger', _knownTriggers);
  final lifecycle = enumerated('appLifecycle', _knownLifecycles);
  final serviceState = enumerated('locationServiceState', _knownServiceStates);
  final powerSource = enumerated('batteryPowerSource', _knownPowerSources);
  final recordingId = required('recordingId');
  final sourceId = required('sourceId');
  final platform = required('platform');
  final appVersion = required('appVersion');
  final screenStateSource = required('screenStateSource');
  final sequence = requiredInt('telemetrySequence');
  final restarts = requiredInt('processRestartCount');
  final lastSequence = requiredInt('locationLogLastSequence', min: -1);
  final monotonic = typed<int>('occurredMonotonicUs');
  final truncated = typed<int>('recoveredTruncatedBytes');

  if (invalid) {
    findings.add(TelemetryFinding('FIELD_TYPE_INVALID', line));
    return null;
  }
  if (outOfRange) {
    findings.add(TelemetryFinding('FIELD_VALUE_OUT_OF_RANGE', line));
    return null;
  }

  return DiagnosticsTelemetryRecord(
    telemetryVersion: row['telemetryVersion'] as int,
    recordingId: recordingId,
    sourceId: sourceId,
    platform: platform,
    appVersion: appVersion,
    deviceBootId: typed<String>('deviceBootId'),
    telemetrySequence: sequence,
    trigger: trigger,
    reasons: List.unmodifiable((reasons as List).cast<String>()),
    occurredAtUtc: timestamp,
    occurredMonotonicUs: monotonic,
    locationLogLastSequence: lastSequence,
    batteryPercent: percent,
    batteryCharging: typed<bool>('batteryCharging'),
    batteryPowerSource: powerSource,
    powerSaveMode: typed<bool>('powerSaveMode'),
    screenInteractive: typed<bool>('screenInteractive'),
    keyguardLocked: typed<bool>('keyguardLocked'),
    protectedDataAvailable: typed<bool>('protectedDataAvailable'),
    screenStateSource: screenStateSource,
    appLifecycle: lifecycle,
    locationServiceState: serviceState,
    locationServiceDetail: typed<String>('locationServiceDetail'),
    processRestartCount: restarts,
    resumeReason: typed<String>('resumeReason'),
    recoveredTruncatedBytes: truncated,
    unavailable: List.unmodifiable(unavailable),
  );
}
