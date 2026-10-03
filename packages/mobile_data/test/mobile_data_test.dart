import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_data/mobile_data.dart';

void main() {
  const directory = '../../testdata/contracts/location-log/v1';
  for (final kind in ['valid', 'invalid']) {
    for (final file in Directory(
      '$directory/$kind',
    ).listSync().whereType<File>().where((f) => f.path.endsWith('.ndjson'))) {
      test('contract fixture ${file.uri.pathSegments.last}', () {
        final report = LocationSampleImporter().addNdjson(
          file.readAsStringSync(),
        );
        expect(report.ok, kind == 'valid', reason: report.findings.join('\n'));
        if (kind == 'invalid') {
          final expected = File(file.path.replaceAll('.ndjson', '.expected'))
              .readAsLinesSync()
              .where((s) => s.isNotEmpty && !s.startsWith('#'));
          expect(
            report.findings.where((f) => f.isError).map((f) => f.code).toSet(),
            containsAll(expected),
          );
        }
      });
    }
  }
  final fixture = File('$directory/valid/01-android-minimal.ndjson')
      .readAsStringSync();
  test('whole-file replay is idempotent; duplicates inside a file fail', () {
    final importer = LocationSampleImporter();
    final first = importer.addNdjson(fixture);
    expect(first.ok, isTrue);
    final replay = importer.addNdjson(fixture);
    expect(replay.ok, isTrue);
    expect(replay.newSamples, isEmpty);
    expect(replay.duplicates, first.allSamples.length);
    final duplicated = LocationSampleImporter().addNdjson('$fixture\n$fixture');
    expect(duplicated.ok, isFalse);
    expect(
      duplicated.findings.map((f) => f.code),
      contains('SEQUENCE_DUPLICATE'),
    );
  });
  test('unknown lines and flags survive import verbatim without failing', () {
    final text = File('$directory/valid/07-forward-compatible-unknowns.ndjson')
        .readAsStringSync();
    final report = LocationSampleImporter().addNdjson(text);
    expect(report.ok, isTrue);
    expect(report.unknownRecords, isNotEmpty);
    for (final raw in [...report.unknownRecords, ...report.events]) {
      expect(text.split('\n'), contains(raw));
    }
    expect(
      report.findings.map((f) => f.code),
      containsAll(['UNKNOWN_RECORD_TYPE', 'UNKNOWN_QUALITY_FLAG']),
    );
  });
  test('unknown events require common fields and retain extra fields', () {
    final event = jsonDecode(fixture.split('\n').first) as Map<String, dynamic>;
    event['eventType'] = 'future_diagnostic';
    event['futureValue'] = 42;
    final raw = jsonEncode(event);
    final accepted = LocationSampleImporter().addNdjson(raw);
    expect(accepted.ok, isTrue);
    expect(accepted.events, [raw]);
    expect(
      accepted.findings.map((f) => f.code),
      contains('UNKNOWN_EVENT_TYPE'),
    );
    event.remove('occurredMonotonicUs');
    final rejected = LocationSampleImporter().addNdjson(jsonEncode(event));
    expect(rejected.ok, isFalse);
    expect(rejected.findings.map((f) => f.code), contains('SCHEMA_INVALID'));
  });
  test(
    'deprecated alias maps to phone_location and null flags stay intact',
    () {
      final text = File(
        '$directory/valid/08-deprecated-source-type-alias.ndjson',
      ).readAsStringSync();
      final report = LocationSampleImporter().addNdjson(text);
      expect(
        report.allSamples.every((s) => s.sourceType == 'phone_location'),
        isTrue,
      );
      expect(
        report.findings.map((f) => f.code),
        contains('SOURCE_TYPE_DEPRECATED'),
      );
    },
  );
  test(
    'changing an earlier imported sequence is a conflict, retains original',
    () {
      final importer = LocationSampleImporter();
      final first = importer.addNdjson(fixture);
      final row = first.allSamples.first.toJson()..['latDeg'] = 0.0;
      final changed = importer.addNdjson(jsonEncode(row));
      expect(changed.ok, isFalse);
      expect(changed.conflicts, 1);
      expect(changed.allSamples.first.latDeg, first.allSamples.first.latDeg);
    },
  );
  test('null and unavailable flags must agree in both directions', () {
    final row = LocationSampleImporter()
        .addNdjson(fixture)
        .allSamples
        .first
        .toJson();
    row['speedMps'] = null;
    expect(
      LocationSampleImporter()
          .addNdjson(jsonEncode(row))
          .findings
          .map((f) => f.code),
      contains('NULL_FLAG_MISMATCH'),
    );
    row['speedMps'] = 1.0;
    row['qualityFlags'] = ['speed_unavailable'];
    expect(
      LocationSampleImporter()
          .addNdjson(jsonEncode(row))
          .findings
          .map((f) => f.code),
      contains('NULL_FLAG_MISMATCH'),
    );
  });
}
