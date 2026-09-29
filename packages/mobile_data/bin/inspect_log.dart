import 'dart:io';

import 'package:mobile_data/mobile_data.dart';

void main(List<String> args) {
  if (args.length != 1) {
    stderr.writeln('Usage: dart run bin/inspect_log.dart <exported.ndjson>');
    exitCode = 64;
    return;
  }
  final report = LocationSampleImporter().addNdjson(
    File(args.single).readAsStringSync(),
  );
  final samples = report.allSamples;
  if (samples.isEmpty) {
    stderr.writeln('No valid samples; invalid lines: ${report.invalidLines}');
    exitCode = 1;
    return;
  }
  final gaps = <double>[];
  var sequenceGaps = 0;
  for (var i = 1; i < samples.length; i++) {
    final previous = samples[i - 1];
    final current = samples[i];
    if (current.recordingId != previous.recordingId ||
        current.sourceId != previous.sourceId) {
      continue;
    }
    if (current.sequence > previous.sequence + 1) {
      sequenceGaps += current.sequence - previous.sequence - 1;
    }
    if (current.deviceBootId == previous.deviceBootId) {
      final gap =
          (current.receivedMonotonicUs - previous.receivedMonotonicUs) /
          1000000;
      if (gap >= 0) gaps.add(gap);
    }
  }
  gaps.sort();
  final flags = <String, int>{};
  for (final sample in samples) {
    for (final flag in sample.qualityFlags) {
      flags.update(flag, (count) => count + 1, ifAbsent: () => 1);
    }
  }
  double percentile(double proportion) =>
      gaps.isEmpty ? 0 : gaps[((gaps.length - 1) * proportion).round()];
  stdout.writeln('Valid samples: ${samples.length}');
  stdout.writeln(
    'Invalid lines: ${report.invalidLines}; duplicates: ${report.duplicates}; '
    'conflicts: ${report.conflicts}; missing sequence numbers: $sequenceGaps',
  );
  stdout.writeln(
    'First measured UTC: ${samples.first.measuredAtUtc.toIso8601String()}',
  );
  stdout.writeln(
    'Last measured UTC: ${samples.last.measuredAtUtc.toIso8601String()}',
  );
  stdout.writeln(
    'Callback gaps within one boot (s): '
    'p50=${percentile(0.5).toStringAsFixed(2)}, '
    'p95=${percentile(0.95).toStringAsFixed(2)}, '
    'max=${percentile(1).toStringAsFixed(2)}, '
    '>5s=${gaps.where((gap) => gap > 5).length}',
  );
  stdout.writeln('Quality flags: $flags');
}
