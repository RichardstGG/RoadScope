import 'location_log_validator.dart';
import 'location_sample.dart';

class LocationImportReport {
  const LocationImportReport({
    required this.newSamples,
    required this.allSamples,
    required this.invalidLines,
    required this.duplicates,
    required this.conflicts,
    required this.findings,
    required this.events,
    required this.unknownRecords,
  });
  final List<LocationSample> newSamples;
  final List<LocationSample> allSamples;
  final int invalidLines, duplicates, conflicts;
  final List<LogFinding> findings;
  final List<String> events, unknownRecords;
  bool get ok => !findings.any((f) => f.isError);
}

/// Each call validates a complete file; replay is idempotent. Duplicate records
/// inside that file remain errors, even when repeated imports are harmless.
class LocationSampleImporter {
  final Map<String, LocationSample> _samples = {};
  final Map<String, String> _original = {};

  LocationImportReport addNdjson(String ndjson) {
    final log = validateLocationLog(ndjson);
    final added = <LocationSample>[];
    var duplicates = 0, conflicts = 0;
    for (var index = 0; index < log.samples.length; index++) {
      final record = log.samples[index];
      final normalized = Map<String, Object?>.of(record);
      for (final key in [
        'sequence',
        'receivedMonotonicUs',
        'measurementMonotonicUs',
      ]) {
        if (normalized[key] is num) {
          normalized[key] = (normalized[key] as num).toInt();
        }
      }
      LocationSample sample;
      try {
        sample = LocationSample.fromJson(normalized);
      } on FormatException {
        log.findings.add(LogFinding('SCHEMA_INVALID', log.sampleLines[index]));
        continue;
      }
      final key =
          '${sample.recordingId}\u0000${sample.sourceId}\u0000${sample.sequence}';
      final canonical = canonicalRecord(record);
      if (_samples.containsKey(key)) {
        duplicates++;
        if (_original[key] != canonical) {
          conflicts++;
          // Line 0 indicates a conflict with an earlier import, not this file.
          if (!log.findings.any((f) => f.code == 'SEQUENCE_CONFLICT')) {
            log.findings.add(const LogFinding('SEQUENCE_CONFLICT', 0));
          }
        }
      } else {
        _samples[key] = sample;
        _original[key] = canonical;
        added.add(sample);
      }
    }
    int compare(LocationSample a, LocationSample b) {
      final recording = a.recordingId.compareTo(b.recordingId);
      if (recording != 0) return recording;
      final source = a.sourceId.compareTo(b.sourceId);
      return source != 0 ? source : a.sequence.compareTo(b.sequence);
    }

    final all = _samples.values.toList()..sort(compare);
    added.sort(compare);
    return LocationImportReport(
      newSamples: List.unmodifiable(added),
      allSamples: List.unmodifiable(all),
      invalidLines: log.findings
          .where((f) => f.isError)
          .map((f) => f.line)
          .toSet()
          .length,
      duplicates: duplicates,
      conflicts: conflicts,
      findings: List.unmodifiable(log.findings),
      events: List.unmodifiable(log.events),
      unknownRecords: List.unmodifiable(log.unknownRecords),
    );
  }
}
