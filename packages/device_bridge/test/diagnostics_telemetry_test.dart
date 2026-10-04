import 'dart:convert';
import 'dart:io';

import 'package:device_bridge/device_bridge.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const _fixtures = '../../testdata/device/diagnostics-telemetry/v1';

String _fixture(String name) => File('$_fixtures/$name').readAsStringSync();

Set<String> _codes(TelemetryReadReport report) =>
    report.findings.map((finding) => finding.code).toSet();

/// A valid row, so a test can change exactly one thing about it.
Map<String, Object?> _row() =>
    jsonDecode(_fixture('android-state-changes.ndjson').split('\n').first)
        as Map<String, Object?>;

String _line(Map<String, Object?> row) => '${jsonEncode(row)}\n';

void main() {
  group('valid telemetry', () {
    test('android file keeps its own sequence space and reports changes', () {
      final report = parseDiagnosticsTelemetry(
        _fixture('android-state-changes.ndjson'),
      );
      expect(report.ok, isTrue, reason: _codes(report).toString());
      expect(report.badLines, 0);
      expect(report.records.length, 5);
      expect(report.records.map((record) => record.telemetrySequence), [
        0,
        1,
        2,
        3,
        4,
      ]);
      expect(report.records.first.trigger, 'recording_started');
      expect(report.records.first.reasons, ['initial_snapshot']);

      final locked = report.records[1];
      expect(locked.screenInteractive, isFalse);
      expect(locked.keyguardLocked, isTrue);
      expect(locked.appLifecycle, 'background');
      // Telemetry only reads the location log's sequence; it never writes it.
      expect(locked.locationLogLastSequence, 149);

      final last = report.latest!;
      expect(last.trigger, 'recording_stopped');
      expect(last.locationServiceState, 'stopped');
      expect(last.batteryPercent, 81);
      expect(last.batteryCharging, isTrue);
      expect(last.batteryPowerSource, 'usb');
      expect(last.occurredAtUtc, DateTime.utc(2026, 10, 3, 4, 10));
      expect(last.occurredMonotonicUs, 10600000000);
    });

    test('ios file records the missing lock API instead of guessing', () {
      final report = parseDiagnosticsTelemetry(
        _fixture('ios-screen-state-unavailable.ndjson'),
      );
      expect(report.ok, isTrue, reason: _codes(report).toString());
      for (final record in report.records) {
        expect(record.platform, 'ios');
        // No public iOS lock API: these must stay null, never false.
        expect(record.screenInteractive, isNull);
        expect(record.keyguardLocked, isNull);
        expect(record.hasUnknownScreenState, isTrue);
        expect(
          record.screenStateSource,
          'ios_no_public_lock_api_protected_data_only',
        );
        expect(
          record.unavailable,
          containsAll([
            'screen_interactive_unavailable',
            'keyguard_state_unavailable',
          ]),
        );
      }
      // Background is not renamed to locked; protected data has its own field.
      expect(report.records[1].protectedDataAvailable, isFalse);
      expect(report.records[1].appLifecycle, 'background');

      final resumed = report.records[2];
      expect(resumed.trigger, 'recording_resumed');
      expect(resumed.resumeReason, 'boot');
      expect(resumed.processRestartCount, 1);
      expect(resumed.locationServiceState, 'restarted');
      expect(resumed.recoveredTruncatedBytes, 48);
      expect(resumed.deviceBootId, 'boot-j');

      final unobservable = report.records[3];
      expect(unobservable.batteryPercent, isNull);
      expect(unobservable.batteryCharging, isNull);
      expect(unobservable.batteryPowerSource, 'unknown');
    });

    test('an empty file is not an error', () {
      final report = parseDiagnosticsTelemetry('');
      expect(report.ok, isTrue);
      expect(report.records, isEmpty);
      expect(report.latest, isNull);
    });

    test('blank lines are skipped and key order does not matter', () {
      final report = parseDiagnosticsTelemetry('\n${_line(_row())}\n   \n');
      expect(report.ok, isTrue, reason: _codes(report).toString());
      expect(report.records.length, 1);
    });
  });

  group('bad data', () {
    test('the mixed fixture reports every error and tolerates newer writers', () {
      final report = parseDiagnosticsTelemetry(
        _fixture('invalid-and-tolerated.ndjson'),
      );
      expect(report.ok, isFalse);
      expect(
        _codes(report),
        containsAll([
          'NOT_JSON',
          'MISSING_RECORD_TYPE',
          'NULL_FLAG_MISMATCH',
          'FIELD_VALUE_OUT_OF_RANGE',
          'FIELD_TYPE_INVALID',
          'SEQUENCE_DUPLICATE',
          'POSITION_FIELD_PRESENT',
        ]),
      );
      // Tolerated: a newer writer must not invalidate the whole file.
      expect(
        _codes(report),
        containsAll([
          'UNKNOWN_RECORD_TYPE',
          'UNKNOWN_ENUM_VALUE',
          'TELEMETRY_SEQUENCE_GAP',
          'INCOMPLETE_TAIL_LINE',
        ]),
      );
      expect(report.unknownRecordTypes.length, 1);
      expect(report.unknownFields, {'futureField'});
      // The truncated tail is a crash artefact, reported but not read as JSON.
      final tail = report.findings.where(
        (f) => f.code == 'INCOMPLETE_TAIL_LINE',
      );
      expect(tail.length, 1);
      expect(tail.single.isError, isFalse);
      // Valid rows before the damage are still returned.
      expect(report.records.map((record) => record.telemetrySequence), [0, 6]);
    });

    test('a flag without a null is as wrong as a null without a flag', () {
      final withoutNull = _row()
        ..['unavailable'] = [
          'protected_data_state_unavailable',
          'battery_percent_unavailable',
        ];
      expect(
        _codes(parseDiagnosticsTelemetry(_line(withoutNull))),
        contains('NULL_FLAG_MISMATCH'),
      );

      final withoutFlag = _row()
        ..['batteryCharging'] = null
        ..['unavailable'] = ['protected_data_state_unavailable'];
      expect(
        _codes(parseDiagnosticsTelemetry(_line(withoutFlag))),
        contains('NULL_FLAG_MISMATCH'),
      );
    });

    test('position data is rejected, not displayed', () {
      for (final key in [
        'latDeg',
        'lonDeg',
        'speedMps',
        'horizontalAccuracyM',
      ]) {
        final row = _row()..[key] = 1.0;
        final report = parseDiagnosticsTelemetry(_line(row));
        expect(_codes(report), contains('POSITION_FIELD_PRESENT'), reason: key);
        expect(report.records, isEmpty, reason: key);
      }
    });

    test('a local UTC offset is rejected so readers cannot disagree', () {
      final row = _row()..['occurredAtUtc'] = '2026-10-03T12:00:00+08:00';
      expect(
        _codes(parseDiagnosticsTelemetry(_line(row))),
        contains('FIELD_TYPE_INVALID'),
      );
    });

    test('wrong types and out-of-range values are errors', () {
      expect(
        _codes(
          parseDiagnosticsTelemetry(_line(_row()..['telemetrySequence'] = 'x')),
        ),
        contains('FIELD_TYPE_INVALID'),
      );
      expect(
        _codes(parseDiagnosticsTelemetry(_line(_row()..['reasons'] = 'x'))),
        contains('FIELD_TYPE_INVALID'),
      );
      expect(
        _codes(parseDiagnosticsTelemetry(_line(_row()..['unavailable'] = 'x'))),
        contains('FIELD_TYPE_INVALID'),
      );
      expect(
        _codes(
          parseDiagnosticsTelemetry(_line(_row()..['batteryPercent'] = -1)),
        ),
        contains('FIELD_VALUE_OUT_OF_RANGE'),
      );
      expect(
        _codes(
          parseDiagnosticsTelemetry(
            _line(_row()..['locationLogLastSequence'] = -2),
          ),
        ),
        contains('FIELD_VALUE_OUT_OF_RANGE'),
      );
      expect(
        _codes(
          parseDiagnosticsTelemetry(_line(_row()..remove('telemetryVersion'))),
        ),
        contains('MISSING_TELEMETRY_VERSION'),
      );
      expect(
        parseDiagnosticsTelemetry('[1,2,3]\n').findings.single.code,
        'NOT_AN_OBJECT',
      );
    });

    test('a newer telemetryVersion warns but still reads', () {
      final report = parseDiagnosticsTelemetry(
        _line(_row()..['telemetryVersion'] = diagnosticsTelemetryVersion + 1),
      );
      expect(_codes(report), contains('NEWER_TELEMETRY_VERSION'));
      expect(report.ok, isTrue);
      expect(report.records.length, 1);
    });

    test('an unknown flag warns and is preserved', () {
      final row = _row()
        ..['unavailable'] = ['protected_data_state_unavailable', 'future_flag'];
      final report = parseDiagnosticsTelemetry(_line(row));
      expect(_codes(report), contains('UNKNOWN_FLAG'));
      expect(report.ok, isTrue);
      expect(report.records.single.unavailable, contains('future_flag'));
    });

    test('task removal is a known Android lifecycle trigger', () {
      final report = parseDiagnosticsTelemetry(
        _line(_row()..['trigger'] = diagnosticsTelemetryTaskRemovedTrigger),
      );
      expect(report.ok, isTrue);
      expect(_codes(report), isNot(contains('UNKNOWN_ENUM_VALUE')));
      expect(
        report.records.single.trigger,
        diagnosticsTelemetryTaskRemovedTrigger,
      );
    });

    test('an interrupted segment is readable and flagged', () {
      final started = _row();
      final interrupted = _row()
        ..['telemetrySequence'] = 1
        ..['trigger'] = diagnosticsTelemetryInterruptedTrigger
        ..['reasons'] = ['previous_segment_not_closed']
        ..['locationLogLastSequence'] = 41
        ..['locationServiceDetail'] =
            'previous process ended without a closing telemetry row'
        // The writer claims nothing about the device at the moment of death.
        ..['batteryPercent'] = null
        ..['batteryCharging'] = null
        ..['batteryPowerSource'] = 'unknown'
        ..['powerSaveMode'] = null
        ..['screenInteractive'] = null
        ..['keyguardLocked'] = null
        ..['appLifecycle'] = 'unknown'
        ..['locationServiceState'] = 'unknown'
        ..['unavailable'] = [
          'protected_data_state_unavailable',
          'battery_percent_unavailable',
          'battery_charging_unavailable',
          'battery_power_source_unknown',
          'power_save_mode_unavailable',
          'screen_interactive_unavailable',
          'keyguard_state_unavailable',
          'app_lifecycle_unknown',
          'location_service_state_unknown',
        ];
      final report = parseDiagnosticsTelemetry(
        '${_line(started)}${_line(interrupted)}',
      );
      expect(report.ok, isTrue, reason: _codes(report).toString());
      expect(report.lastSegmentInterrupted, isTrue);
      final last = report.latest!;
      expect(last.trigger, 'recording_interrupted');
      expect(last.locationLogLastSequence, 41);
      expect(last.batteryPercent, isNull);
      expect(last.screenInteractive, isNull);
      expect(last.appLifecycle, 'unknown');
      expect(last.locationServiceState, 'unknown');
    });

    test('a normally closed file is not reported as interrupted', () {
      final report = parseDiagnosticsTelemetry(
        _fixture('android-state-changes.ndjson'),
      );
      expect(report.latest!.trigger, 'recording_stopped');
      expect(report.lastSegmentInterrupted, isFalse);
      // An empty file cannot claim anything either way.
      expect(parseDiagnosticsTelemetry('').lastSegmentInterrupted, isFalse);
    });

    test('reading the same file twice gives the same answer', () {
      final text = _fixture('android-state-changes.ndjson');
      final first = parseDiagnosticsTelemetry(text);
      final second = parseDiagnosticsTelemetry(text);
      expect(second.records.length, first.records.length);
      expect(second.ok, first.ok);
    });
  });

  group('method channel', () {
    TestWidgetsFlutterBinding.ensureInitialized();
    const channel = MethodChannel('device_bridge');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

    tearDown(() => messenger.setMockMethodCallHandler(channel, null));

    test(
      'telemetry is read from its own channel call and its own path',
      () async {
        final calls = <String>[];
        messenger.setMockMethodCallHandler(channel, (call) async {
          calls.add(call.method);
          return switch (call.method) {
            'status' => <String, Object?>{
              'state': 'idle',
              'logPath': '/tmp/rec-1.ndjson',
              'telemetryPath': '/tmp/rec-1.telemetry.ndjson',
            },
            'readLog' => '',
            'readTelemetry' => _fixture('android-state-changes.ndjson'),
            _ => null,
          };
        });
        const bridge = DeviceBridge();
        final status = await bridge.status();
        expect(status.logPath, '/tmp/rec-1.ndjson');
        expect(status.telemetryPath, '/tmp/rec-1.telemetry.ndjson');
        final report = await bridge.telemetry();
        expect(report.records.length, 5);
        expect(report.ok, isTrue);
        expect(calls, ['status', 'readTelemetry']);
      },
    );

    test(
      'a platform without telemetry reads as empty, not as an error',
      () async {
        messenger.setMockMethodCallHandler(
          channel,
          (call) async => switch (call.method) {
            'status' => <String, Object?>{'state': 'idle'},
            _ => null,
          },
        );
        const bridge = DeviceBridge();
        expect((await bridge.status()).telemetryPath, isNull);
        expect(await bridge.readTelemetry(), '');
        expect((await bridge.telemetry()).records, isEmpty);
      },
    );
  });
}
