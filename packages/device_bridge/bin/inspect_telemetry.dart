import 'dart:io';

import 'package:device_bridge/diagnostics_telemetry.dart';

/// Reads one or more diagnostics telemetry files and prints a summary.
///
/// Use it on a file exported from a phone, and in CI on the files the Android
/// unit tests produce, so the Kotlin writer and this Dart reader stay aligned.
/// It reports what the OS told the app; it is not evidence that background
/// collection is stable.
///
///   `dart run bin/inspect_telemetry.dart [--strict] <file.telemetry.ndjson>...`
void main(List<String> arguments) {
  final strict = arguments.contains('--strict');
  final paths = arguments.where((argument) => argument != '--strict').toList();
  if (paths.isEmpty) {
    stderr.writeln(
      'usage: dart run bin/inspect_telemetry.dart [--strict] <file.ndjson>...',
    );
    exitCode = 64;
    return;
  }

  var failed = false;
  for (final path in paths) {
    final file = File(path);
    if (!file.existsSync()) {
      stderr.writeln('$path: not found');
      failed = true;
      continue;
    }
    final report = parseDiagnosticsTelemetry(file.readAsStringSync());
    stdout.writeln(path);
    stdout.writeln(
      '  records: ${report.records.length}'
      '  bad lines: ${report.badLines}'
      '  unknown record types: ${report.unknownRecordTypes.length}',
    );
    if (report.unknownFields.isNotEmpty) {
      stdout.writeln('  unknown fields: ${report.unknownFields.join(', ')}');
    }
    final counts = <String, int>{};
    for (final record in report.records) {
      counts[record.trigger] = (counts[record.trigger] ?? 0) + 1;
    }
    if (counts.isNotEmpty) stdout.writeln('  triggers: $counts');
    final latest = report.latest;
    if (latest != null) {
      stdout.writeln(
        '  latest: ${latest.occurredAtUtc?.toIso8601String() ?? 'utc unavailable'}'
        '  battery: ${latest.batteryPercent ?? 'unavailable'}'
        '  charging: ${latest.batteryCharging ?? 'unavailable'}'
        '  app: ${latest.appLifecycle}'
        '  screen interactive: ${latest.screenInteractive ?? 'unavailable'}'
        '  keyguard: ${latest.keyguardLocked ?? 'unavailable'}'
        '  service: ${latest.locationServiceState}',
      );
      stdout.writeln('  screen state source: ${latest.screenStateSource}');
    }
    for (final finding in report.findings) {
      stdout.writeln(
        '  ${finding.isError ? 'error' : 'warn'} '
        'line ${finding.line}: ${finding.code}',
      );
    }
    if (!report.ok) failed = true;
  }

  if (strict && failed) exitCode = 1;
}
