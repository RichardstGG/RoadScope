#!/usr/bin/env node
// Validates native location log NDJSON against contracts/location-log/v1.
// The schema covers one record; this tool adds the cross-line rules a schema
// cannot express: sequence continuity, monotonic direction, boot changes.
// Usage: node validate-location-log.mjs [--json] <file.ndjson> [...]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '../location-log/v1/record.schema.json');

export const KNOWN_QUALITY_FLAGS = new Set([
  'speed_unavailable',
  'heading_unavailable',
  'horizontal_accuracy_unavailable',
  'speed_accuracy_unavailable',
  'altitude_unavailable',
  'measurement_monotonic_unavailable',
  'synthetic',
]);

const KNOWN_RECORD_TYPES = new Set(['sample', 'event']);
const DEPRECATED_SOURCE_TYPES = new Map([['phone_gnss', 'phone_location']]);

// A nullable measurement and its *_unavailable flag must agree in both
// directions. The schema enforces this too, but its errors name the rule, not
// the field, so the pair is checked here to keep the report readable.
const NULLABLE_PAIRS = [
  ['speedMps', 'speed_unavailable'],
  ['headingDeg', 'heading_unavailable'],
  ['horizontalAccuracyM', 'horizontal_accuracy_unavailable'],
  ['speedAccuracyMps', 'speed_accuracy_unavailable'],
  ['altitudeM', 'altitude_unavailable'],
  ['measurementMonotonicUs', 'measurement_monotonic_unavailable'],
];

const EVENT_DEFS = {
  recording_started: 'eventRecordingStarted',
  clock_adjusted: 'eventClockAdjusted',
  log_truncated: 'eventLogTruncated',
  recording_resumed: 'eventRecordingResumed',
};

const ERROR = 'error';
const WARN = 'warn';

// A finding is an error only when timing_core cannot trust the data.
// Situations the contract explicitly tolerates stay warnings on purpose:
// failing them would break forward compatibility with a newer writer.
const SEVERITY = {
  NOT_JSON: ERROR,
  MISSING_RECORD_TYPE: ERROR,
  SCHEMA_INVALID: ERROR,
  NULL_FLAG_MISMATCH: ERROR,
  SEQUENCE_CONFLICT: ERROR,
  SEQUENCE_DUPLICATE: ERROR,
  MONOTONIC_REGRESSION: ERROR,
  MEASUREMENT_MONOTONIC_REGRESSION: ERROR,
  EVENT_SEQUENCE_AHEAD: ERROR,
  SEQUENCE_GAP: WARN,
  BOOT_ID_CHANGE_UNDECLARED: WARN,
  SOURCE_TYPE_DEPRECATED: WARN,
  UNKNOWN_QUALITY_FLAG: WARN,
  UNKNOWN_RECORD_TYPE: WARN,
  UNKNOWN_EVENT_TYPE: WARN,
  MISSING_RECORDING_STARTED: WARN,
};

const STREAM_SEPARATOR = String.fromCharCode(0);

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(schema);

// Compiled per record kind rather than through the root oneOf: a oneOf failure
// reports every branch, which buries the real problem under ~90 messages.
const compiled = new Map();
function subSchema(name) {
  if (!compiled.has(name)) {
    compiled.set(name, ajv.getSchema(`${schema.$id}#/$defs/${name}`));
  }
  return compiled.get(name);
}

export function validateLocationLog(text) {
  const findings = [];
  const add = (code, line, detail) =>
    findings.push({ code, severity: SEVERITY[code] ?? ERROR, line, detail });

  const streams = new Map();
  const streamOf = (key) => {
    if (!streams.has(key)) streams.set(key, newStream());
    return streams.get(key);
  };

  let samples = 0;
  let events = 0;
  let unknownRecords = 0;

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const lineNumber = index + 1;
    if (raw.trim() === '') continue;

    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      add('NOT_JSON', lineNumber, error.message);
      continue;
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      add('NOT_JSON', lineNumber, 'record must be a JSON object');
      continue;
    }

    // Two situations that must not share a code path. An absent recordType is
    // the pre-contract layout: unsupported, and accepting it as a sample would
    // also let a genuinely corrupt line through.
    if (record.recordType === undefined) {
      add('MISSING_RECORD_TYPE', lineNumber, 'recordType is required from schemaVersion 1 onward');
      continue;
    }
    // A known field carrying an unknown value is a newer writer: tolerate it.
    if (!KNOWN_RECORD_TYPES.has(record.recordType)) {
      unknownRecords += 1;
      add('UNKNOWN_RECORD_TYPE', lineNumber, String(record.recordType));
      continue;
    }

    if (record.recordType === 'event') {
      if (!checkEvent(record, lineNumber, add)) continue;
      events += 1;
      applyEvent(streamOf(streamKey(record)), record, lineNumber, add);
      continue;
    }

    if (!checkSample(record, lineNumber, add)) continue;
    samples += 1;
    applySample(streamOf(streamKey(record)), record, lineNumber, add);
  }

  const errorCount = findings.filter((finding) => finding.severity === ERROR).length;
  return {
    ok: errorCount === 0,
    samples,
    events,
    unknownRecords,
    streams: streams.size,
    findings,
    errorCount,
    warnCount: findings.length - errorCount,
  };
}

function streamKey(record) {
  return `${record.recordingId}${STREAM_SEPARATOR}${record.sourceId}`;
}

function newStream() {
  return {
    samples: new Map(),
    maxSequence: -1,
    expectedNext: null,
    lastBootId: null,
    bootChangeDeclared: false,
    started: false,
    lastReceivedMonotonic: new Map(),
    lastMeasurementMonotonic: new Map(),
  };
}

// Returns true when the record may take part in cross-line checks.
function checkSample(record, lineNumber, add) {
  const mismatches = nullFlagMismatches(record);
  for (const detail of mismatches) add('NULL_FLAG_MISMATCH', lineNumber, detail);

  const validate = subSchema('sample');
  if (!validate(record)) {
    // Pair errors are already reported above with the field name.
    const rest = (validate.errors ?? []).filter(
      (error) => !error.schemaPath.includes('/nullFlagConsistency/'),
    );
    if (rest.length > 0) {
      add('SCHEMA_INVALID', lineNumber, ajv.errorsText(rest, { separator: '; ' }));
      return false;
    }
  }
  return mismatches.length === 0;
}

function nullFlagMismatches(record) {
  if (!Array.isArray(record.qualityFlags)) return [];
  const details = [];
  for (const [field, flag] of NULLABLE_PAIRS) {
    if (!(field in record)) continue;
    const isNull = record[field] === null;
    const hasFlag = record.qualityFlags.includes(flag);
    if (isNull && !hasFlag) details.push(`${field} is null but ${flag} is missing`);
    if (!isNull && hasFlag) details.push(`${flag} is present but ${field} is not null`);
  }
  return details;
}

function checkEvent(record, lineNumber, add) {
  const validateBase = subSchema('eventBase');
  if (!validateBase(record)) {
    add('SCHEMA_INVALID', lineNumber, ajv.errorsText(validateBase.errors, { separator: '; ' }));
    return false;
  }
  const defName = EVENT_DEFS[record.eventType];
  if (!defName) {
    // Forward compatibility: a newer writer's event still carries a usable base.
    add('UNKNOWN_EVENT_TYPE', lineNumber, String(record.eventType));
    return true;
  }
  const validate = subSchema(defName);
  if (!validate(record)) {
    add('SCHEMA_INVALID', lineNumber, ajv.errorsText(validate.errors, { separator: '; ' }));
    return false;
  }
  return true;
}

function applyEvent(stream, record, lineNumber, add) {
  if (record.eventType === 'recording_started') stream.started = true;

  // lastSequence names the last sample already written, or -1 before the first.
  // It must never run ahead of what the log actually contains.
  if (record.lastSequence > stream.maxSequence) {
    add(
      'EVENT_SEQUENCE_AHEAD',
      lineNumber,
      `lastSequence ${record.lastSequence} exceeds last written sample ${stream.maxSequence}`,
    );
  }

  if (record.eventType === 'log_truncated' || record.eventType === 'recording_resumed') {
    stream.expectedNext = record.resumedSequence;
  }
  if (record.eventType === 'clock_adjusted' || record.eventType === 'recording_resumed') {
    stream.bootChangeDeclared = true;
  }
  stream.lastBootId = record.deviceBootId;
}

function applySample(stream, record, lineNumber, add) {
  if (!stream.started) {
    add('MISSING_RECORDING_STARTED', lineNumber, 'stream does not open with recording_started');
    stream.started = true; // report once per stream
  }

  const replacement = DEPRECATED_SOURCE_TYPES.get(record.sourceType);
  if (replacement) {
    add('SOURCE_TYPE_DEPRECATED', lineNumber, `${record.sourceType} -> ${replacement}`);
  }

  for (const flag of record.qualityFlags) {
    if (!KNOWN_QUALITY_FLAGS.has(flag)) add('UNKNOWN_QUALITY_FLAG', lineNumber, flag);
  }

  // Re-reading a whole log must be idempotent, but one log must not contain the
  // same sequence twice: the native side is a single writer.
  const canonical = canonicalJson(record);
  const previous = stream.samples.get(record.sequence);
  if (previous !== undefined) {
    add(
      previous === canonical ? 'SEQUENCE_DUPLICATE' : 'SEQUENCE_CONFLICT',
      lineNumber,
      `sequence ${record.sequence} already present in this stream`,
    );
  } else {
    stream.samples.set(record.sequence, canonical);
  }

  if (stream.expectedNext !== null && record.sequence > stream.expectedNext) {
    add('SEQUENCE_GAP', lineNumber, `expected ${stream.expectedNext}, found ${record.sequence}`);
  }
  stream.expectedNext = Math.max(stream.expectedNext ?? 0, record.sequence + 1);
  stream.maxSequence = Math.max(stream.maxSequence, record.sequence);

  // A boot change mid-recording is legal, but it is a monotonic discontinuity.
  // Undeclared, the data layer cannot tell it from clock drift.
  if (stream.lastBootId !== null && stream.lastBootId !== record.deviceBootId) {
    if (!stream.bootChangeDeclared) {
      add(
        'BOOT_ID_CHANGE_UNDECLARED',
        lineNumber,
        `${stream.lastBootId} -> ${record.deviceBootId} without clock_adjusted or recording_resumed`,
      );
    }
    stream.bootChangeDeclared = false;
  }
  stream.lastBootId = record.deviceBootId;

  // Monotonic clocks may only be compared inside one deviceBootId.
  checkMonotonic(stream.lastReceivedMonotonic, record.deviceBootId, record.receivedMonotonicUs, {
    code: 'MONOTONIC_REGRESSION',
    field: 'receivedMonotonicUs',
    lineNumber,
    add,
  });
  if (record.measurementMonotonicUs !== null) {
    checkMonotonic(
      stream.lastMeasurementMonotonic,
      record.deviceBootId,
      record.measurementMonotonicUs,
      { code: 'MEASUREMENT_MONOTONIC_REGRESSION', field: 'measurementMonotonicUs', lineNumber, add },
    );
  }
}

function checkMonotonic(lastByBoot, bootId, value, { code, field, lineNumber, add }) {
  const last = lastByBoot.get(bootId);
  if (last !== undefined && value < last) {
    add(code, lineNumber, `${field} ${value} < ${last} within deviceBootId ${bootId}`);
  }
  lastByBoot.set(bootId, value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function main(argv) {
  const asJson = argv.includes('--json');
  const files = argv.filter((argument) => !argument.startsWith('--'));
  if (files.length === 0) {
    process.stderr.write('usage: validate-location-log.mjs [--json] <file.ndjson> [...]\n');
    return 2;
  }

  let failed = false;
  const results = [];
  for (const file of files) {
    const result = validateLocationLog(readFileSync(file, 'utf8'));
    results.push({ file, ...result });
    if (!result.ok) failed = true;
    if (asJson) continue;
    process.stdout.write(
      `${result.ok ? 'PASS' : 'FAIL'} ${file} - ${result.samples} samples, ${result.events} events, ` +
        `${result.streams} stream(s), ${result.errorCount} error(s), ${result.warnCount} warning(s)\n`,
    );
    for (const finding of result.findings) {
      const mark = finding.severity === ERROR ? 'E' : 'W';
      process.stdout.write(`  ${mark} line ${finding.line} ${finding.code}: ${finding.detail}\n`);
    }
  }
  if (asJson) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
