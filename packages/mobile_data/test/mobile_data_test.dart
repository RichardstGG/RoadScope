import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_data/mobile_data.dart';

void main() {
  Map<String, Object?> sample(int sequence) => {
    'schemaVersion': 1,
    'recordingId': 'synthetic-recording',
    'sourceId': 'synthetic-source',
    'sourceType': 'synthetic',
    'deviceBootId': 'synthetic-boot',
    'sequence': sequence,
    'measuredAtUtc': '2026-09-29T10:00:0${sequence}Z',
    'receivedAtUtc': '2026-09-29T10:00:0$sequence.050Z',
    'measurementMonotonicUs': 1000000 + sequence * 1000000,
    'receivedMonotonicUs': 1050000 + sequence * 1000000,
    'latDeg': 25.0 + sequence * 0.0001,
    'lonDeg': 121.0,
    'altitudeM': null,
    'speedMps': null,
    'headingDeg': null,
    'horizontalAccuracyM': 5.0,
    'speedAccuracyMps': null,
    'qualityFlags': ['invalid_speed'],
  };

  test('replay sorts by sequence and rejects duplicate imports', () {
    final importer = LocationSampleImporter();
    final lines = [
      jsonEncode(sample(2)),
      jsonEncode(sample(0)),
      jsonEncode(sample(1)),
    ].join('\n');
    final first = importer.addNdjson(lines);
    expect(first.newSamples.map((item) => item.sequence), [0, 1, 2]);
    expect(first.invalidLines, 0);

    final replay = importer.addNdjson(lines);
    expect(replay.newSamples, isEmpty);
    expect(replay.duplicates, 3);
    expect(replay.allSamples.map((item) => item.sequence), [0, 1, 2]);
  });

  test('invalid values stay null and conflicting sequence is reported', () {
    final importer = LocationSampleImporter();
    final first = importer.addNdjson(jsonEncode(sample(0)));
    expect(first.allSamples.single.speedMps, isNull);
    expect(first.allSamples.single.qualityFlags, contains('invalid_speed'));

    final changed = sample(0)..['latDeg'] = 25.5;
    final conflict = importer.addNdjson(jsonEncode(changed));
    expect(conflict.duplicates, 1);
    expect(conflict.conflicts, 1);
    expect(conflict.allSamples.single.latDeg, 25.0);

    final invalid = sample(1)..['speedMps'] = -1.0;
    final invalidReport = importer.addNdjson(jsonEncode(invalid));
    expect(invalidReport.invalidLines, 1);
    expect(invalidReport.allSamples, hasLength(1));
  });

  test('shared synthetic fixture remains parseable and marked synthetic', () {
    final fixture = File('../../testdata/location-sample-synthetic.ndjson').readAsStringSync();
    final report = LocationSampleImporter().addNdjson(fixture);
    expect(report.invalidLines, 0);
    expect(report.allSamples, hasLength(2));
    expect(report.allSamples.first.qualityFlags, contains('synthetic'));
    expect(report.allSamples.first.speedMps, isNull);
    expect(report.allSamples.last.speedMps, 4.1);
  });
}
