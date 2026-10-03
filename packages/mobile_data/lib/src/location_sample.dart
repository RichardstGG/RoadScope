import 'location_log_validator.dart';

/// Raw location update from location-log v1.
class LocationSample {
  LocationSample({
    required this.recordingId,
    required this.sourceId,
    required this.sourceType,
    required this.deviceBootId,
    required this.sequence,
    required this.measuredAtUtc,
    required this.receivedAtUtc,
    required this.measurementMonotonicUs,
    required this.receivedMonotonicUs,
    required this.latDeg,
    required this.lonDeg,
    required this.altitudeM,
    required this.speedMps,
    required this.headingDeg,
    required this.horizontalAccuracyM,
    required this.speedAccuracyMps,
    required this.qualityFlags,
  }) {
    if ([
      recordingId,
      sourceId,
      sourceType,
      deviceBootId,
    ].any((value) => value.isEmpty)) {
      throw const FormatException('sample identity must be nonempty');
    }
    if (sequence < 0 ||
        receivedMonotonicUs < 0 ||
        (measurementMonotonicUs != null && measurementMonotonicUs! < 0)) {
      throw const FormatException(
        'sequence and monotonic times must be nonnegative',
      );
    }
    if (!measuredAtUtc.isUtc || !receivedAtUtc.isUtc) {
      throw const FormatException('timestamps must be UTC');
    }
    if (!latDeg.isFinite ||
        latDeg < -90 ||
        latDeg > 90 ||
        !lonDeg.isFinite ||
        lonDeg < -180 ||
        lonDeg > 180) {
      throw const FormatException('coordinate outside WGS84 range');
    }
    for (final value in [
      altitudeM,
      speedMps,
      headingDeg,
      horizontalAccuracyM,
      speedAccuracyMps,
    ]) {
      if (value != null && !value.isFinite) {
        throw const FormatException('non-finite numeric sample value');
      }
    }
    if ((speedMps != null && speedMps! < 0) ||
        (horizontalAccuracyM != null && horizontalAccuracyM! < 0) ||
        (speedAccuracyMps != null && speedAccuracyMps! < 0) ||
        (headingDeg != null && (headingDeg! < 0 || headingDeg! >= 360))) {
      throw const FormatException('invalid speed, heading, or accuracy');
    }
  }

  static const int currentSchemaVersion = 1;
  final String recordingId;
  final String sourceId;
  final String sourceType;
  final String deviceBootId;
  final int sequence;
  final DateTime measuredAtUtc;
  final DateTime receivedAtUtc;
  final int? measurementMonotonicUs;
  final int receivedMonotonicUs;
  final double latDeg;
  final double lonDeg;
  final double? altitudeM;
  final double? speedMps;
  final double? headingDeg;
  final double? horizontalAccuracyM;
  final double? speedAccuracyMps;
  final List<String> qualityFlags;

  factory LocationSample.fromJson(Map<String, Object?> json) {
    final findings = validateSampleFields(json, 1);
    if (findings.isNotEmpty) {
      throw FormatException(findings.map((f) => f.code).join(', '));
    }
    if (json['schemaVersion'] != currentSchemaVersion) {
      throw const FormatException('unsupported LocationSample schemaVersion');
    }
    DateTime utc(String key) {
      final raw = json[key];
      if (raw is! String || !raw.endsWith('Z')) {
        throw FormatException('$key must use RFC3339 UTC');
      }
      final parsed = DateTime.tryParse(raw);
      if (parsed == null || !parsed.isUtc) {
        throw FormatException('$key is not a UTC timestamp');
      }
      return parsed;
    }

    double? optionalNumber(String key) {
      final value = json[key];
      if (value == null) return null;
      if (value is! num) throw FormatException('$key must be numeric or null');
      return value.toDouble();
    }

    T requiredValue<T>(String key) {
      final value = json[key];
      if (value is! T) throw FormatException('$key has the wrong type');
      return value;
    }

    final flags = requiredValue<List<Object?>>('qualityFlags');
    if (flags.any((flag) => flag is! String)) {
      throw const FormatException('qualityFlags must contain strings');
    }
    final monotonic = json['measurementMonotonicUs'];
    if (monotonic != null && monotonic is! int) {
      throw const FormatException(
        'measurementMonotonicUs must be integer or null',
      );
    }
    return LocationSample(
      recordingId: requiredValue<String>('recordingId'),
      sourceId: requiredValue<String>('sourceId'),
      sourceType: json['sourceType'] == 'phone_gnss'
          ? 'phone_location'
          : requiredValue<String>('sourceType'),
      deviceBootId: requiredValue<String>('deviceBootId'),
      sequence: requiredValue<int>('sequence'),
      measuredAtUtc: utc('measuredAtUtc'),
      receivedAtUtc: utc('receivedAtUtc'),
      measurementMonotonicUs: monotonic as int?,
      receivedMonotonicUs: requiredValue<int>('receivedMonotonicUs'),
      latDeg: requiredValue<num>('latDeg').toDouble(),
      lonDeg: requiredValue<num>('lonDeg').toDouble(),
      altitudeM: optionalNumber('altitudeM'),
      speedMps: optionalNumber('speedMps'),
      headingDeg: optionalNumber('headingDeg'),
      horizontalAccuracyM: optionalNumber('horizontalAccuracyM'),
      speedAccuracyMps: optionalNumber('speedAccuracyMps'),
      qualityFlags: List.unmodifiable(flags.cast<String>()),
    );
  }

  Map<String, Object?> toJson() => {
    'schemaVersion': currentSchemaVersion,
    'recordType': 'sample',
    'recordingId': recordingId,
    'sourceId': sourceId,
    'sourceType': sourceType,
    'deviceBootId': deviceBootId,
    'sequence': sequence,
    'measuredAtUtc': measuredAtUtc.toIso8601String(),
    'receivedAtUtc': receivedAtUtc.toIso8601String(),
    'measurementMonotonicUs': measurementMonotonicUs,
    'receivedMonotonicUs': receivedMonotonicUs,
    'latDeg': latDeg,
    'lonDeg': lonDeg,
    'altitudeM': altitudeM,
    'speedMps': speedMps,
    'headingDeg': headingDeg,
    'horizontalAccuracyM': horizontalAccuracyM,
    'speedAccuracyMps': speedAccuracyMps,
    'qualityFlags': qualityFlags,
  };
}
