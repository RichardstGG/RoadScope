import 'dart:convert';

import 'location_sample.dart';

class LocationImportReport {
  const LocationImportReport({
    required this.newSamples,
    required this.allSamples,
    required this.invalidLines,
    required this.duplicates,
    required this.conflicts,
  });

  final List<LocationSample> newSamples;
  final List<LocationSample> allSamples;
  final int invalidLines;
  final int duplicates;
  final int conflicts;
}

/// Imports a native append-only NDJSON log by (recordingId, sourceId, sequence).
/// Re-reading a log is idempotent; after app restart, replaying the complete
/// native log reconstructs the same order.
class LocationSampleImporter {
  final Map<String, LocationSample> _samples = {};

  LocationImportReport addNdjson(String ndjson) {
    final added = <LocationSample>[];
    var invalid = 0;
    var duplicates = 0;
    var conflicts = 0;
    for (final line in const LineSplitter().convert(ndjson)) {
      if (line.trim().isEmpty) continue;
      try {
        final decoded = jsonDecode(line);
        if (decoded is! Map<String, dynamic>) {
          throw const FormatException('sample must be an object');
        }
        final sample = LocationSample.fromJson(decoded);
        final key =
            '${sample.recordingId}\u0000${sample.sourceId}\u0000${sample.sequence}';
        final previous = _samples[key];
        if (previous == null) {
          _samples[key] = sample;
          added.add(sample);
        } else {
          duplicates++;
          if (jsonEncode(previous.toJson()) != jsonEncode(sample.toJson())) {
            conflicts++;
          }
        }
      } on FormatException {
        invalid++;
      } on TypeError {
        invalid++;
      }
    }
    int compare(LocationSample a, LocationSample b) {
      final byRecording = a.recordingId.compareTo(b.recordingId);
      if (byRecording != 0) return byRecording;
      final bySource = a.sourceId.compareTo(b.sourceId);
      if (bySource != 0) return bySource;
      return a.sequence.compareTo(b.sequence);
    }

    final all = _samples.values.toList()..sort(compare);
    added.sort(compare);
    return LocationImportReport(
      newSamples: List.unmodifiable(added),
      allSamples: List.unmodifiable(all),
      invalidLines: invalid,
      duplicates: duplicates,
      conflicts: conflicts,
    );
  }
}
