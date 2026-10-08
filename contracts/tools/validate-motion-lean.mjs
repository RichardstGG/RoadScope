#!/usr/bin/env node
// Validates the raw motion log and the derived lean log against
// contracts/motion-lean/v1. The schemas cover one record; this tool adds the
// cross-line rules a schema cannot express: sequence continuity, monotonic
// direction, clock-map references, calibration segmentation and extrema.
// Usage: node validate-motion-lean.mjs [--json] [--motion <motion.ndjson>] <file.ndjson> [...]
// A lean file is checked against a motion file only when --motion is given.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(here, '../motion-lean/v1');

const ERROR = 'error';
const WARN = 'warn';

const WARNINGS = new Set([
  'SEQUENCE_GAP',
  'BOOT_ID_CHANGE_UNDECLARED',
  'UNKNOWN_QUALITY_FLAG',
  'UNKNOWN_RECORD_TYPE',
  'UNKNOWN_EVENT_TYPE',
  'UNKNOWN_SENSOR_TYPE',
  'MISSING_MOTION_STARTED',
  'MISSING_LEAN_STARTED',
  'MOTION_TIME_GAP',
  'MEASUREMENT_RECEIVED_SKEW',
]);
// Everything not listed above is an error: timing/lean consumers cannot trust
// the data. Warnings are the situations the contract tolerates on purpose, so
// that a newer writer's data is never rejected wholesale.
const severityOf = (code) => (WARNINGS.has(code) ? WARN : ERROR);

export const KNOWN_MOTION_FLAGS = new Set([
  'measurement_monotonic_unavailable',
  'accuracy_unavailable',
  'clock_map_unavailable',
  'synthetic',
]);
export const KNOWN_LEAN_FLAGS = new Set([
  'lean_unavailable',
  'no_valid_calibration',
  'lean_axis_unknown',
  'input_gap',
  'after_input_gap',
  'dynamic_acceleration_high',
  'carried_over_unverified',
  'clock_map_unavailable',
  'synthetic',
]);
// An estimate carrying any of these cannot be extremum-eligible.
export const BLOCKING_LEAN_FLAGS = new Set([
  'lean_unavailable',
  'no_valid_calibration',
  'lean_axis_unknown',
  'input_gap',
  'after_input_gap',
  'dynamic_acceleration_high',
]);
// Any other leanAxisSource value (including a newer writer's) means "axis unknown".
const USABLE_AXIS_SOURCES = new Set(['manual_left_lean', 'inherited_from_previous']);

const MOTION_RECORD_TYPES = new Set(['motion_sample', 'motion_event']);
const LEAN_RECORD_TYPES = new Set([
  'lean_calibration',
  'lean_estimate',
  'lean_extremum',
  'lean_segment_closed',
  'lean_event',
]);

const SAMPLE_DEFS = {
  accelerometer: 'accelerometerSample',
  gyroscope: 'gyroscopeSample',
  attitude: 'attitudeSample',
};
const MOTION_EVENT_DEFS = {
  motion_started: 'eventMotionStarted',
  clock_map: 'eventClockMap',
  source_clock_state: 'eventSourceClockState',
  samples_dropped: 'eventSamplesDropped',
  clock_adjusted: 'eventClockAdjusted',
  log_truncated: 'eventLogTruncated',
  recording_resumed: 'eventRecordingResumed',
};
const LEAN_EVENT_DEFS = {
  lean_started: 'eventLeanStarted',
  calibration_invalidated: 'eventCalibrationInvalidated',
  estimator_reset: 'eventEstimatorReset',
  estimator_state: 'eventEstimatorState',
  records_dropped: 'eventRecordsDropped',
  clock_adjusted: 'eventClockAdjusted',
  log_truncated: 'eventLogTruncated',
  recording_resumed: 'eventRecordingResumed',
};
const LEAN_RECORD_DEFS = {
  lean_calibration: 'leanCalibration',
  lean_estimate: 'leanEstimate',
  lean_extremum: 'leanExtremum',
  lean_segment_closed: 'leanSegmentClosed',
};

const MOTION_NULL_PAIRS = [
  ['measurementMonotonicUs', 'measurement_monotonic_unavailable'],
  ['accuracyLevel', 'accuracy_unavailable'],
  ['clockMapId', 'clock_map_unavailable'],
];
const LEAN_ESTIMATE_NULL_PAIRS = [
  ['leanAngleDeg', 'lean_unavailable'],
  ['calibrationId', 'no_valid_calibration'],
  ['clockMapId', 'clock_map_unavailable'],
];

const UNIT_TOLERANCE = 1e-3;
const ORTHOGONAL_TOLERANCE = 0.02;
const ANGLE_TOLERANCE_DEG = 1e-6;
// A sensor timestamp this far behind the callback suggests a different clock
// domain (uptime instead of elapsedRealtime) rather than batching latency.
const SKEW_WARN_US = 10_000_000;

const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const name of ['common', 'motion', 'lean']) {
  ajv.addSchema(JSON.parse(readFileSync(resolve(schemaDir, `${name}.schema.json`), 'utf8')));
}
const ID = {
  motion: 'https://contracts.roadscope.invalid/motion-lean/v1/motion.schema.json',
  lean: 'https://contracts.roadscope.invalid/motion-lean/v1/lean.schema.json',
};
const compiled = new Map();
function subSchema(file, name) {
  const key = `${file}#${name}`;
  if (!compiled.has(key)) compiled.set(key, ajv.getSchema(`${ID[file]}#/$defs/${name}`));
  return compiled.get(key);
}

// ---------------------------------------------------------------- shared

function newReport() {
  const findings = [];
  return {
    findings,
    add: (code, line, detail) => findings.push({ code, severity: severityOf(code), line, detail }),
  };
}

function finish(report, extra) {
  const errorCount = report.findings.filter((f) => f.severity === ERROR).length;
  return {
    ok: errorCount === 0,
    findings: report.findings,
    errorCount,
    warnCount: report.findings.length - errorCount,
    ...extra,
  };
}

// Yields parsed records with their line number; reports the three line-level
// failure modes shared by both logs.
function* records(text, knownTypes, add, counters) {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    if (raw.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      add('NOT_JSON', line, error.message);
      continue;
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      add('NOT_JSON', line, 'record must be a JSON object');
      continue;
    }
    if (record.recordType === undefined) {
      add('MISSING_RECORD_TYPE', line, 'recordType is required');
      continue;
    }
    if (!knownTypes.has(record.recordType)) {
      // A known field with an unknown value is a newer writer (or another
      // log's line): preserve it, count it, keep going.
      counters.unknown += 1;
      add('UNKNOWN_RECORD_TYPE', line, String(record.recordType));
      continue;
    }
    yield { record, line };
  }
}

function schemaCheck(file, defName, record, line, add) {
  const validate = subSchema(file, defName);
  if (validate(record)) return true;
  add('SCHEMA_INVALID', line, ajv.errorsText(validate.errors, { separator: '; ' }));
  return false;
}

function nullFlagMismatches(record, pairs) {
  if (!Array.isArray(record.qualityFlags)) return [];
  const details = [];
  for (const [field, flag] of pairs) {
    if (!(field in record)) continue;
    const isNull = record[field] === null;
    const hasFlag = record.qualityFlags.includes(flag);
    if (isNull && !hasFlag) details.push(`${field} is null but ${flag} is missing`);
    if (!isNull && hasFlag) details.push(`${flag} is present but ${field} is not null`);
  }
  return details;
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

const norm = (v) => Math.hypot(v.x, v.y, v.z);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

// Tracks one (recordingId, sourceId) sequence space.
function newSequenceSpace() {
  return { seen: new Map(), maxSequence: -1, expectedNext: null };
}

function applySequence(space, record, line, add, label) {
  const canonical = canonicalJson(record);
  const previous = space.seen.get(record.sequence);
  if (previous !== undefined) {
    add(
      previous === canonical ? 'SEQUENCE_DUPLICATE' : 'SEQUENCE_CONFLICT',
      line,
      `${label} sequence ${record.sequence} already present`,
    );
  } else {
    space.seen.set(record.sequence, canonical);
  }
  if (space.expectedNext !== null && record.sequence > space.expectedNext) {
    add('SEQUENCE_GAP', line, `${label} expected ${space.expectedNext}, found ${record.sequence}`);
  }
  space.expectedNext = Math.max(space.expectedNext ?? 0, record.sequence + 1);
  space.maxSequence = Math.max(space.maxSequence, record.sequence);
}

// A boot change must be declared by an event placed before the first record
// of the new boot. Events that declare it: clock_adjusted, recording_resumed.
function trackBoot(state, record, declaring, line, add) {
  if (state.lastBootId !== null && state.lastBootId !== record.deviceBootId && !declaring) {
    add(
      'BOOT_ID_CHANGE_UNDECLARED',
      line,
      `${state.lastBootId} -> ${record.deviceBootId} without clock_adjusted or recording_resumed`,
    );
  }
  state.lastBootId = record.deviceBootId;
}

function checkMonotonic(lastByBoot, bootId, value, ctx) {
  const last = lastByBoot.get(bootId);
  if (last !== undefined && value < last) {
    ctx.add(ctx.code, ctx.line, `${ctx.field} ${value} < ${last} within deviceBootId ${bootId}`);
  }
  lastByBoot.set(bootId, value);
}

// ---------------------------------------------------------------- motion

export function validateMotionLog(text) {
  const report = newReport();
  const { add } = report;
  const counters = { unknown: 0 };
  const spaces = new Map();
  const spaceOf = (source) => {
    if (!spaces.has(source)) spaces.set(source, newSequenceSpace());
    return spaces.get(source);
  };
  const state = {
    lastBootId: null,
    started: false,
    declared: new Map(), // sourceId -> declaration of the latest motion_started
    clockState: new Map(), // sourceId -> measurementClock in force at this point of the file
    segmentOpen: false, // true between a motion_started and the next resume/boot declaration
    lastSeen: new Map(), // sourceId -> {sequence, boot} of the previous sample
    clockMaps: new Map(), // mapId -> event
    lastMeasurement: new Map(), // sourceId -> Map(bootId -> us)
    lastReceived: new Map(),
    lastTime: new Map(), // sourceId -> {boot, us} for gap detection
    cover: new Map(), // sourceId -> [{boot, from, to}]
    allCover: [],
  };
  // `breaks` are points where a source's input is not continuous: a replay or
  // an estimate must not straddle one. nextSeq is the first sequence after it.
  const model = { sequences: new Map(), breaks: new Map(), declarations: new Map() };
  let sampleCount = 0;
  let eventCount = 0;

  for (const { record, line } of records(text, MOTION_RECORD_TYPES, add, counters)) {
    if (record.recordType === 'motion_event') {
      if (!checkMotionEvent(record, line, add)) continue;
      eventCount += 1;
      applyMotionEvent(state, spaceOf, record, line, add, model);
      continue;
    }
    if (!checkMotionSample(record, line, add)) continue;
    sampleCount += 1;
    applyMotionSample(state, spaceOf(record.sourceId), record, line, add, model);
  }

  return finish(report, {
    kind: 'motion',
    samples: sampleCount,
    events: eventCount,
    unknownRecords: counters.unknown,
    model,
  });
}

function checkMotionSample(record, line, add) {
  const mismatches = nullFlagMismatches(record, MOTION_NULL_PAIRS);
  for (const detail of mismatches) add('NULL_FLAG_MISMATCH', line, detail);

  const known = SAMPLE_DEFS[record.sensorType];
  if (!known && typeof record.sensorType === 'string') {
    // An unknown sensor type from a newer writer still carries a usable base.
    add('UNKNOWN_SENSOR_TYPE', line, record.sensorType);
  }
  const defName = known ?? 'motionSampleBase';
  const validate = subSchema('motion', defName);
  if (!validate(record)) {
    add('SCHEMA_INVALID', line, ajv.errorsText(validate.errors, { separator: '; ' }));
    return false;
  }
  if (record.sensorType === 'attitude') {
    const length = Math.hypot(record.qw, record.qx, record.qy, record.qz);
    if (Math.abs(length - 1) > UNIT_TOLERANCE) {
      add('QUATERNION_NOT_UNIT', line, `|q| = ${length}`);
      return false;
    }
  }
  return mismatches.length === 0;
}

function checkMotionEvent(record, line, add) {
  const base = subSchema('motion', 'motionEventBase');
  if (!base(record)) {
    add('SCHEMA_INVALID', line, ajv.errorsText(base.errors, { separator: '; ' }));
    return false;
  }
  const defName = MOTION_EVENT_DEFS[record.eventType];
  if (!defName) {
    add('UNKNOWN_EVENT_TYPE', line, String(record.eventType));
    return true;
  }
  return schemaCheck('motion', defName, record, line, add);
}

function applyMotionEvent(state, spaceOf, record, line, add, model) {
  const declaring = record.eventType === 'clock_adjusted' || record.eventType === 'recording_resumed';
  trackBoot(state, record, declaring, line, add);
  if (declaring) state.segmentOpen = false;

  for (const [source, last] of Object.entries(record.lastSequences)) {
    const space = spaceOf(source);
    if (last > space.maxSequence) {
      add('EVENT_SEQUENCE_AHEAD', line, `${source}: lastSequences ${last} exceeds last written sample ${space.maxSequence}`);
    }
  }

  switch (record.eventType) {
    case 'motion_started': {
      state.started = true;
      // A repeated motion_started inside one segment must not rewrite a clock
      // state that source_clock_state events own.
      for (const source of record.sources) {
        const current = state.clockState.get(source.sourceId);
        if (state.segmentOpen && current !== undefined && current !== source.measurementClock) {
          add('SOURCE_CLOCK_REDECLARED', line, `${source.sourceId} ${current} -> ${source.measurementClock} without source_clock_state`);
        } else {
          state.clockState.set(source.sourceId, source.measurementClock);
        }
        if (source.available) {
          const known = model.declarations.get(source.sourceId);
          model.declarations.set(source.sourceId, {
            storageStride: Math.max(known?.storageStride ?? 1, source.storageStride),
          });
        }
      }
      state.segmentOpen = true;
      state.declared = new Map(record.sources.map((s) => [s.sourceId, s]));
      break;
    }
    case 'source_clock_state': {
      const tracked = state.clockState.get(record.sourceId);
      if (!state.declared.has(record.sourceId)) {
        add('SOURCE_NOT_DECLARED', line, `${record.sourceId} has no declaration to change`);
        break;
      }
      if (tracked !== record.previousMeasurementClock || record.measurementClock === record.previousMeasurementClock) {
        add('SOURCE_CLOCK_STATE_CHAIN', line, `${record.sourceId} is ${tracked}; event claims ${record.previousMeasurementClock} -> ${record.measurementClock}`);
        break;
      }
      state.clockState.set(record.sourceId, record.measurementClock);
      // Leaving or entering elapsed_realtime interrupts the usable input.
      pushTo(model.breaks, record.sourceId, { boot: record.deviceBootId, nextSeq: spaceOf(record.sourceId).maxSequence + 1 });
      pushTo(state.cover, record.sourceId, { boot: record.deviceBootId, from: 0, to: record.occurredMonotonicUs });
      break;
    }
    case 'clock_map': {
      if (state.clockMaps.has(record.mapId)) {
        add('CLOCK_MAP_ID_REUSED', line, `mapId ${record.mapId} already defined`);
      } else {
        state.clockMaps.set(record.mapId, record);
      }
      break;
    }
    case 'samples_dropped': {
      const times = state.lastTime.get(record.sourceId);
      // Unknown bounds: the loss lies between the last sample seen and now.
      const from = record.firstDroppedMonotonicUs ?? times?.us ?? 0;
      const to = record.lastDroppedMonotonicUs ?? record.occurredMonotonicUs;
      const entry = { boot: record.deviceBootId, from, to };
      pushTo(state.cover, record.sourceId, entry);
      pushTo(model.breaks, record.sourceId, { boot: record.deviceBootId, nextSeq: spaceOf(record.sourceId).maxSequence + 1 });
      break;
    }
    case 'log_truncated':
    case 'recording_resumed': {
      for (const [source, next] of Object.entries(record.resumedSequences)) {
        spaceOf(source).expectedNext = next;
      }
      state.allCover.push({ boot: record.deviceBootId, from: 0, to: record.occurredMonotonicUs });
      break;
    }
    default:
      break;
  }
}

function pushTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function applyMotionSample(state, space, record, line, add, model) {
  if (!state.started) {
    add('MISSING_MOTION_STARTED', line, 'log does not open with motion_started');
    state.started = true; // report once
  }
  if (state.declared.size > 0) {
    const declaration = state.declared.get(record.sourceId);
    if (!declaration || declaration.available === false) {
      add('SOURCE_NOT_DECLARED', line, `${record.sourceId} is not an available source of the latest motion_started`);
    } else if (declaration) {
      if (declaration.sensorType !== record.sensorType) {
        add('SENSOR_TYPE_MISMATCH', line, `${record.sourceId} declared ${declaration.sensorType}, sample says ${record.sensorType}`);
      }
    }
  }
  // The clock state is positional: a verification that passes later does not
  // validate earlier samples, and a failure does not invalidate them.
  const clock = state.clockState.get(record.sourceId);
  if (clock === 'elapsed_realtime' && record.measurementMonotonicUs === null) {
    add('MEASUREMENT_CLOCK_MISMATCH', line, `${record.sourceId} is verified (elapsed_realtime) but the sample has no measurement time`);
  } else if (clock !== undefined && clock !== 'elapsed_realtime' && record.measurementMonotonicUs !== null) {
    add('MEASUREMENT_CLOCK_MISMATCH', line, `${record.sourceId} is ${clock} but the sample carries a measurement time`);
  }

  for (const flag of record.qualityFlags) {
    if (!KNOWN_MOTION_FLAGS.has(flag)) add('UNKNOWN_QUALITY_FLAG', line, flag);
  }

  const previousSeen = state.lastSeen.get(record.sourceId);
  applySequence(space, record, line, add, record.sourceId);
  trackBoot(state, record, false, line, add);
  if (previousSeen && record.sequence > previousSeen.sequence) {
    // A sequence hole (truncation) or a boot change also breaks continuity.
    if (record.sequence !== previousSeen.sequence + 1 || previousSeen.boot !== record.deviceBootId) {
      pushTo(model.breaks, record.sourceId, { boot: record.deviceBootId, nextSeq: record.sequence });
    }
  }
  if (!previousSeen || record.sequence > previousSeen.sequence) {
    state.lastSeen.set(record.sourceId, { sequence: record.sequence, boot: record.deviceBootId });
  }

  const received = bootMap(state.lastReceived, record.sourceId);
  checkMonotonic(received, record.deviceBootId, record.receivedMonotonicUs, {
    add,
    line,
    code: 'MONOTONIC_REGRESSION',
    field: `${record.sourceId} receivedMonotonicUs`,
  });

  const measured = record.measurementMonotonicUs;
  if (measured !== null) {
    checkMonotonic(bootMap(state.lastMeasurement, record.sourceId), record.deviceBootId, measured, {
      add,
      line,
      code: 'MEASUREMENT_MONOTONIC_REGRESSION',
      field: `${record.sourceId} measurementMonotonicUs`,
    });
    // A measurement cannot happen after its own callback. The usual cause is a
    // unit mix-up (ns/ms written as us) or a different clock domain.
    if (measured > record.receivedMonotonicUs) {
      add('MEASUREMENT_AFTER_RECEIVED', line, `measurementMonotonicUs ${measured} > receivedMonotonicUs ${record.receivedMonotonicUs}`);
    } else if (record.receivedMonotonicUs - measured > SKEW_WARN_US) {
      add('MEASUREMENT_RECEIVED_SKEW', line, `callback ${(record.receivedMonotonicUs - measured) / 1e6}s after measurement`);
    }
    detectGap(state, record, measured, line, add);
  }

  if (record.clockMapId !== null) {
    const map = state.clockMaps.get(record.clockMapId);
    if (!map) {
      add('CLOCK_MAP_UNKNOWN', line, `clockMapId ${record.clockMapId} has no preceding clock_map event`);
    } else if (map.deviceBootId !== record.deviceBootId) {
      add('CLOCK_MAP_BOOT_MISMATCH', line, `clock map ${map.mapId} belongs to ${map.deviceBootId}, sample is ${record.deviceBootId}`);
    }
  }

  if (!model.sequences.has(record.sourceId)) model.sequences.set(record.sourceId, new Map());
  model.sequences.get(record.sourceId).set(record.sequence, { boot: record.deviceBootId, measurementUs: measured });
}

function bootMap(map, key) {
  if (!map.has(key)) map.set(key, new Map());
  return map.get(key);
}

function detectGap(state, record, measured, line, add) {
  const previous = state.lastTime.get(record.sourceId);
  state.lastTime.set(record.sourceId, { boot: record.deviceBootId, us: measured });
  if (!previous || previous.boot !== record.deviceBootId) return;
  const declaration = state.declared.get(record.sourceId);
  if (!declaration || declaration.available === false) return;
  if (measured - previous.us <= declaration.gapThresholdUs) return;
  const overlaps = (c) => c.boot === record.deviceBootId && c.from <= measured && c.to >= previous.us;
  const covered =
    (state.cover.get(record.sourceId) ?? []).some(overlaps) || state.allCover.some(overlaps);
  if (!covered) {
    add('MOTION_TIME_GAP', line, `${record.sourceId} gap of ${measured - previous.us} us exceeds gapThresholdUs ${declaration.gapThresholdUs} with no samples_dropped or resume event`);
  }
}

// ---------------------------------------------------------------- lean

export function validateLeanLog(text, { motion = null } = {}) {
  const report = newReport();
  const { add } = report;
  const counters = { unknown: 0 };
  const space = new Map();
  const spaceOf = (source) => {
    if (!space.has(source)) space.set(source, newSequenceSpace());
    return space.get(source);
  };
  const state = {
    lastBootId: null,
    started: false,
    policy: null,
    calibrations: new Map(),
    currentId: null,
    estimates: new Map(), // sequence -> record
    lastEstimateMeasurement: new Map(), // boot -> us
    lastMeasurementByBoot: new Map(),
    extremaBest: new Map(), // `${calibrationId}|${side}` -> record
    closed: new Set(),
    eligibleCount: new Map(),
    replayable: false,
    epochs: new Map(), // filterEpoch -> {reason, initialInputs: Map(sourceId -> sequence)}
    currentEpoch: null,
    unavailable: false,
    resumeAfterEpoch: null,
    strideReported: new Set(),
  };
  let recordCount = 0;
  let eventCount = 0;

  for (const { record, line } of records(text, LEAN_RECORD_TYPES, add, counters)) {
    if (record.recordType === 'lean_event') {
      if (!checkLeanEvent(record, line, add)) continue;
      eventCount += 1;
      applyLeanEvent(state, spaceOf, record, line, add);
      continue;
    }
    if (!checkLeanRecord(record, line, add)) continue;
    recordCount += 1;
    for (const flag of record.qualityFlags) {
      if (!KNOWN_LEAN_FLAGS.has(flag)) add('UNKNOWN_QUALITY_FLAG', line, flag);
    }
    if (!state.started) {
      add('MISSING_LEAN_STARTED', line, 'log does not open with lean_started');
      state.started = true;
    }
    applySequence(spaceOf(record.sourceId), record, line, add, record.sourceId);
    // A closing record describes the segment's own boot, which can be the
    // previous one: it does not take part in boot tracking.
    if (record.recordType !== 'lean_segment_closed') trackBoot(state, record, false, line, add);
    switch (record.recordType) {
      case 'lean_calibration':
        applyCalibration(state, record, line, add);
        break;
      case 'lean_estimate':
        applyEstimate(state, record, line, add, motion);
        break;
      case 'lean_extremum':
        applyExtremum(state, record, line, add);
        break;
      default:
        applySegmentClosed(state, record, line, add);
    }
  }

  return finish(report, {
    kind: 'lean',
    records: recordCount,
    events: eventCount,
    unknownRecords: counters.unknown,
    pairedWithMotion: motion !== null,
  });
}

function checkLeanRecord(record, line, add) {
  const pairs = record.recordType === 'lean_estimate' ? LEAN_ESTIMATE_NULL_PAIRS : [];
  const mismatches = nullFlagMismatches(record, pairs);
  for (const detail of mismatches) add('NULL_FLAG_MISMATCH', line, detail);
  if (!schemaCheck('lean', LEAN_RECORD_DEFS[record.recordType], record, line, add)) return false;
  if (record.recordType === 'lean_calibration') {
    for (const field of ['upDevice', 'leanAxisDevice']) {
      if (Math.abs(norm(record[field]) - 1) > UNIT_TOLERANCE) {
        add('VECTOR_NOT_UNIT', line, `${field} length ${norm(record[field])}`);
        return false;
      }
    }
    const cosine = dot(record.upDevice, record.leanAxisDevice);
    if (Math.abs(cosine) > ORTHOGONAL_TOLERANCE) {
      add('AXIS_NOT_ORTHOGONAL', line, `upDevice . leanAxisDevice = ${cosine}`);
      return false;
    }
  }
  return mismatches.length === 0;
}

function checkLeanEvent(record, line, add) {
  const base = subSchema('lean', 'leanEventBase');
  if (!base(record)) {
    add('SCHEMA_INVALID', line, ajv.errorsText(base.errors, { separator: '; ' }));
    return false;
  }
  const defName = LEAN_EVENT_DEFS[record.eventType];
  if (!defName) {
    add('UNKNOWN_EVENT_TYPE', line, String(record.eventType));
    return true;
  }
  return schemaCheck('lean', defName, record, line, add);
}

function applyLeanEvent(state, spaceOf, record, line, add) {
  const declaring = record.eventType === 'clock_adjusted' || record.eventType === 'recording_resumed';
  trackBoot(state, record, declaring, line, add);

  const space = spaceOf(record.sourceId);
  if (record.lastSequence > space.maxSequence) {
    add('EVENT_SEQUENCE_AHEAD', line, `lastSequence ${record.lastSequence} exceeds last written record ${space.maxSequence}`);
  }
  if (record.eventType === 'lean_started') {
    state.started = true;
    state.policy = record.extremumPolicy;
    state.replayable = record.replayable;
  }
  if (record.eventType === 'estimator_reset') {
    const expected = state.currentEpoch === null ? 0 : state.currentEpoch + 1;
    if (record.filterEpoch !== expected) {
      add('ESTIMATOR_EPOCH_ORDER', line, `filterEpoch ${record.filterEpoch}, expected ${expected}`);
    } else {
      state.epochs.set(record.filterEpoch, {
        reason: record.reason,
        initialInputs: new Map(record.initialInputs.map((i) => [i.sourceId, i.firstSequence])),
      });
      state.currentEpoch = record.filterEpoch;
    }
  }
  if (record.eventType === 'estimator_state') {
    if (record.state === 'unavailable') {
      state.unavailable = true;
    } else if (state.unavailable) {
      // Coming back needs a fresh epoch: the fusion state did not survive.
      state.unavailable = false;
      state.resumeAfterEpoch = state.currentEpoch ?? -1;
    }
  }
  if (record.eventType === 'log_truncated' || record.eventType === 'recording_resumed') {
    space.expectedNext = record.resumedSequence;
  }
  if (record.eventType === 'calibration_invalidated') {
    const calibration = state.calibrations.get(record.calibrationId);
    if (!calibration) {
      add('CALIBRATION_UNKNOWN', line, `calibration_invalidated names unknown ${record.calibrationId}`);
    } else {
      calibration.invalidatedAt = record.invalidatedAtMonotonicUs;
    }
  }
}

function applyCalibration(state, record, line, add) {
  if (state.calibrations.has(record.calibrationId)) {
    add('CALIBRATION_DUPLICATE_ID', line, record.calibrationId);
    return;
  }
  if (record.effectiveFromMonotonicUs > record.writtenMonotonicUs) {
    add('CALIBRATION_ORDER', line, 'effectiveFromMonotonicUs is later than writtenMonotonicUs: a calibration cannot take effect in the future');
  }
  const current = state.currentId ? state.calibrations.get(state.currentId) : null;
  if (record.supersedesCalibrationId !== null && !state.calibrations.has(record.supersedesCalibrationId)) {
    add('CALIBRATION_SUPERSEDES_UNKNOWN', line, record.supersedesCalibrationId);
  } else if (
    current &&
    current.deviceBootId === record.deviceBootId &&
    current.invalidatedAt === null &&
    !state.closed.has(current.calibrationId) &&
    record.supersedesCalibrationId !== current.calibrationId
  ) {
    add('CALIBRATION_SUPERSEDES_MISMATCH', line, `current calibration ${current.calibrationId} is neither superseded nor invalidated`);
  }
  if (record.leanAxisSource === 'inherited_from_previous' && record.supersedesCalibrationId === null) {
    add('CALIBRATION_SUPERSEDES_UNKNOWN', line, 'inherited_from_previous requires supersedesCalibrationId');
  }
  if (record.origin === 'carried_over' && !state.calibrations.has(record.carriedOverFromCalibrationId)) {
    add('CALIBRATION_SUPERSEDES_UNKNOWN', line, `carriedOverFromCalibrationId ${record.carriedOverFromCalibrationId} is unknown`);
  }
  // Already-written estimates are never rewritten: a new calibration may only
  // take effect after the newest estimate on disk.
  const lastEstimate = state.lastEstimateMeasurement.get(record.deviceBootId);
  if (lastEstimate !== undefined && record.effectiveFromMonotonicUs <= lastEstimate) {
    add('CALIBRATION_RETROACTIVE', line, `effectiveFromMonotonicUs ${record.effectiveFromMonotonicUs} <= already written estimate at ${lastEstimate}`);
  }
  if (current && current.deviceBootId === record.deviceBootId && record.effectiveFromMonotonicUs < current.effectiveFromMonotonicUs) {
    add('CALIBRATION_ORDER', line, 'effectiveFromMonotonicUs precedes the calibration it replaces');
  }
  if (record.supersedesCalibrationId !== null && state.calibrations.has(record.supersedesCalibrationId)) {
    state.calibrations.get(record.supersedesCalibrationId).supersededBy = record.calibrationId;
  }
  state.calibrations.set(record.calibrationId, { ...record, invalidatedAt: null, supersededBy: null });
  state.currentId = record.calibrationId;
}

function applyEstimate(state, record, line, add, motion) {
  const measured = record.measurementMonotonicUs;
  checkMonotonic(bootMap(state.lastMeasurementByBoot, 'estimate'), record.deviceBootId, measured, {
    add,
    line,
    code: 'MEASUREMENT_MONOTONIC_REGRESSION',
    field: 'estimate measurementMonotonicUs',
  });
  state.lastEstimateMeasurement.set(
    record.deviceBootId,
    Math.max(state.lastEstimateMeasurement.get(record.deviceBootId) ?? 0, measured),
  );
  if (record.computedMonotonicUs < measured) {
    add('COMPUTED_BEFORE_MEASURED', line, 'computedMonotonicUs precedes measurementMonotonicUs');
  }

  if (state.unavailable) {
    add('ESTIMATE_WHILE_UNAVAILABLE', line, 'estimator_state is unavailable: no estimate may be written, none is invented from receive time');
  }
  if (state.currentEpoch === null || !state.epochs.has(record.filterEpoch)) {
    add('ESTIMATE_EPOCH_UNKNOWN', line, `filterEpoch ${record.filterEpoch} has no estimator_reset`);
  } else if (record.filterEpoch !== state.currentEpoch) {
    add('ESTIMATE_EPOCH_STALE', line, `filterEpoch ${record.filterEpoch}, current is ${state.currentEpoch}`);
  } else if (state.resumeAfterEpoch !== null && record.filterEpoch <= state.resumeAfterEpoch) {
    add('ESTIMATE_EPOCH_STALE', line, `estimator became available again without a new estimator_reset`);
  }

  const flags = new Set(record.qualityFlags);
  if (record.extremumEligible) {
    const blocking = [...flags].filter((flag) => BLOCKING_LEAN_FLAGS.has(flag));
    if (record.leanAngleDeg === null || blocking.length > 0) {
      add('EXTREMUM_ELIGIBLE_BLOCKED', line, `extremumEligible with ${record.leanAngleDeg === null ? 'null angle' : blocking.join(', ')}`);
    }
  }

  if (record.calibrationId === null) {
    if (record.leanAngleDeg !== null) add('ANGLE_WITHOUT_CALIBRATION', line, 'leanAngleDeg is set but calibrationId is null');
  } else {
    const calibration = state.calibrations.get(record.calibrationId);
    if (!calibration) {
      add('CALIBRATION_UNKNOWN', line, record.calibrationId);
    } else {
      if (calibration.deviceBootId !== record.deviceBootId) {
        add('CALIBRATION_BOOT_MISMATCH', line, `calibration ${calibration.calibrationId} belongs to ${calibration.deviceBootId}, estimate is ${record.deviceBootId}`);
      }
      if (calibration.supersededBy !== null) {
        add('ESTIMATE_STALE_CALIBRATION', line, `${calibration.calibrationId} was superseded by ${calibration.supersededBy}`);
      }
      if (measured < calibration.effectiveFromMonotonicUs) {
        add('ESTIMATE_BEFORE_CALIBRATION', line, `measurement ${measured} < effectiveFromMonotonicUs ${calibration.effectiveFromMonotonicUs}`);
      }
      if (calibration.invalidatedAt !== null && measured >= calibration.invalidatedAt) {
        add('ESTIMATE_ON_INVALIDATED_CALIBRATION', line, `${calibration.calibrationId} invalidated at ${calibration.invalidatedAt}`);
      }
      if (state.closed.has(calibration.calibrationId)) {
        add('ESTIMATE_AFTER_SEGMENT_CLOSED', line, calibration.calibrationId);
      }
      if (record.leanAngleDeg !== null && !USABLE_AXIS_SOURCES.has(calibration.leanAxisSource)) {
        add('ANGLE_WITH_UNKNOWN_AXIS', line, `calibration ${calibration.calibrationId} has leanAxisSource ${calibration.leanAxisSource}`);
      }
      const count = state.eligibleCount.get(calibration.calibrationId) ?? { eligible: 0, ineligible: 0 };
      if (record.extremumEligible) count.eligible += 1;
      else count.ineligible += 1;
      state.eligibleCount.set(calibration.calibrationId, count);
    }
  }

  state.estimates.set(record.sequence, record);
  if (motion) checkSourceRefs(record, line, add, motion, state);
}

function checkSourceRefs(record, line, add, motion, state) {
  let newestInput = -1;
  let spansBreak = false;
  for (const ref of record.sourceRefs) {
    const samples = motion.model.sequences.get(ref.sourceId);
    const first = samples?.get(ref.firstSequence);
    const last = samples?.get(ref.lastSequence);
    // Only sequences the motion log actually holds can be referenced: an
    // estimate must never name an input whose raw append failed.
    if (ref.firstSequence > ref.lastSequence || !first || !last) {
      add('SOURCE_REF_UNRESOLVED', line, `${ref.sourceId} ${ref.firstSequence}..${ref.lastSequence} not found in the motion log`);
      continue;
    }
    if (first.boot !== record.deviceBootId || last.boot !== record.deviceBootId) {
      add('SOURCE_REF_BOOT_MISMATCH', line, `${ref.sourceId} samples belong to ${first.boot}/${last.boot}, estimate is ${record.deviceBootId}`);
      continue;
    }
    if (last.measurementUs === null) {
      add('SOURCE_REF_NO_MEASUREMENT_TIME', line, `${ref.sourceId} sequence ${ref.lastSequence} has no measurement time; receive time may not stand in for it`);
      continue;
    }
    newestInput = Math.max(newestInput, last.measurementUs);
    const breaks = (motion.model.breaks.get(ref.sourceId) ?? []).filter((b) => b.boot === record.deviceBootId);
    if (breaks.some((b) => ref.firstSequence < b.nextSeq && b.nextSeq <= ref.lastSequence)) spansBreak = true;
    if (state.replayable && record.leanAngleDeg !== null) checkReplay(record, ref, samples, breaks, line, add, motion, state);
  }
  if (newestInput >= 0 && newestInput !== record.measurementMonotonicUs) {
    add('ESTIMATE_TIME_MISMATCH', line, `measurementMonotonicUs ${record.measurementMonotonicUs} != newest referenced input ${newestInput}`);
  }
  if (spansBreak && !(record.leanAngleDeg === null && record.qualityFlags.includes('input_gap'))) {
    add('ESTIMATE_SPANS_GAP', line, 'referenced inputs span a recorded gap, clock change or boot change: the angle must be null with input_gap');
  }
}

// Fusion has history: an estimate depends on every input since its epoch
// boundary, not just on the newest referenced samples.
function checkReplay(record, ref, samples, breaks, line, add, motion, state) {
  const initial = state.epochs.get(record.filterEpoch)?.initialInputs.get(ref.sourceId);
  if (initial === undefined) {
    add('REPLAY_INPUTS_INCOMPLETE', line, `epoch ${record.filterEpoch} declares no initial input for ${ref.sourceId}`);
    return;
  }
  if (ref.firstSequence < initial) {
    add('SOURCE_REF_BEFORE_EPOCH', line, `${ref.sourceId} ref starts at ${ref.firstSequence}, before epoch start ${initial}`);
  }
  const start = samples.get(initial);
  if (!start || start.boot !== record.deviceBootId) {
    add('REPLAY_INPUTS_INCOMPLETE', line, `${ref.sourceId} epoch start ${initial} is not stored in this boot`);
  } else if (breaks.some((b) => initial < b.nextSeq && b.nextSeq <= ref.lastSequence)) {
    add('REPLAY_INPUTS_INCOMPLETE', line, `${ref.sourceId} has a gap, clock change or boot change inside epoch ${record.filterEpoch}`);
  }
  const stride = motion.model.declarations.get(ref.sourceId)?.storageStride ?? 1;
  if (stride > 1 && !state.strideReported.has(ref.sourceId)) {
    state.strideReported.add(ref.sourceId);
    add('REPLAY_STRIDE_DROPS_INPUTS', line, `${ref.sourceId} storageStride ${stride} discards inputs the filter used, yet replayable is true`);
  }
}

function applyExtremum(state, record, line, add) {
  const calibration = state.calibrations.get(record.calibrationId);
  if (!calibration) {
    add('CALIBRATION_UNKNOWN', line, record.calibrationId);
    return;
  }
  if (calibration.deviceBootId !== record.deviceBootId) {
    add('CALIBRATION_BOOT_MISMATCH', line, `extremum boot ${record.deviceBootId} != calibration boot ${calibration.deviceBootId}`);
  }
  if (record.eventMonotonicUs < calibration.effectiveFromMonotonicUs) {
    add('ESTIMATE_BEFORE_CALIBRATION', line, 'extremum event precedes its calibration');
  }
  if (record.windowStartMonotonicUs > record.eventMonotonicUs || record.eventMonotonicUs > record.windowEndMonotonicUs) {
    add('EXTREMUM_WINDOW_TOO_SHORT', line, 'eventMonotonicUs must lie inside [windowStart, windowEnd]');
  } else if (state.policy && record.windowEndMonotonicUs - record.windowStartMonotonicUs < state.policy.minWindowUs) {
    add('EXTREMUM_WINDOW_TOO_SHORT', line, `window ${record.windowEndMonotonicUs - record.windowStartMonotonicUs} us < minWindowUs ${state.policy.minWindowUs}`);
  }

  const estimate = state.estimates.get(record.estimateSequence);
  if (!estimate || estimate.calibrationId !== record.calibrationId || !estimate.extremumEligible) {
    add('EXTREMUM_ESTIMATE_INELIGIBLE', line, `estimate ${record.estimateSequence} is missing, under another calibration, or not extremumEligible`);
  } else {
    const sideOk = record.side === 'left' ? estimate.leanAngleDeg < 0 : estimate.leanAngleDeg > 0;
    if (
      !sideOk ||
      Math.abs(Math.abs(estimate.leanAngleDeg) - record.peakAbsAngleDeg) > ANGLE_TOLERANCE_DEG ||
      estimate.measurementMonotonicUs !== record.eventMonotonicUs
    ) {
      add('EXTREMUM_VALUE_MISMATCH', line, `extremum does not equal estimate ${record.estimateSequence} (side, |angle| or measurement time)`);
    }
  }

  const key = `${record.calibrationId}|${record.side}`;
  const best = state.extremaBest.get(key);
  if (best && record.peakAbsAngleDeg < best.peakAbsAngleDeg) {
    add('EXTREMUM_DECREASED', line, `${record.side} peak ${record.peakAbsAngleDeg} < previous ${best.peakAbsAngleDeg} in ${record.calibrationId}`);
    return;
  }
  state.extremaBest.set(key, record);
}

function applySegmentClosed(state, record, line, add) {
  const calibration = state.calibrations.get(record.calibrationId);
  if (!calibration) {
    add('CALIBRATION_UNKNOWN', line, record.calibrationId);
    return;
  }
  if (state.closed.has(record.calibrationId)) {
    add('SEGMENT_CLOSED_TWICE', line, record.calibrationId);
    return;
  }
  state.closed.add(record.calibrationId);
  if (calibration.deviceBootId !== record.deviceBootId) {
    add('CALIBRATION_BOOT_MISMATCH', line, 'lean_segment_closed carries the segment boot, not the writing boot');
  }
  if (record.closedAtMonotonicUs < calibration.effectiveFromMonotonicUs) {
    add('SEGMENT_SUMMARY_MISMATCH', line, 'closedAtMonotonicUs precedes the segment start');
  }
  for (const [field, side] of [['maxLeft', 'left'], ['maxRight', 'right']]) {
    const best = state.extremaBest.get(`${record.calibrationId}|${side}`) ?? null;
    const claimed = record[field];
    if (best === null && claimed !== null) {
      add('SEGMENT_SUMMARY_MISMATCH', line, `${field} is set but no ${side} extremum was written`);
    } else if (best !== null && claimed === null) {
      add('SEGMENT_SUMMARY_MISMATCH', line, `${field} is null but a ${side} extremum of ${best.peakAbsAngleDeg} was written`);
    } else if (
      best !== null &&
      (claimed.extremumSequence !== best.sequence ||
        claimed.eventMonotonicUs !== best.eventMonotonicUs ||
        Math.abs(claimed.peakAbsAngleDeg - best.peakAbsAngleDeg) > ANGLE_TOLERANCE_DEG)
    ) {
      add('SEGMENT_SUMMARY_MISMATCH', line, `${field} differs from the best ${side} extremum record (sequence ${best.sequence})`);
    }
  }
}

// ---------------------------------------------------------------- CLI

function detectKind(text) {
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const type = JSON.parse(raw)?.recordType;
      if (MOTION_RECORD_TYPES.has(type)) return 'motion';
      if (LEAN_RECORD_TYPES.has(type)) return 'lean';
    } catch {
      // Keep looking: a corrupt first line must not hide the log's kind.
    }
  }
  return null;
}

function main(argv) {
  const asJson = argv.includes('--json');
  let motionPath = null;
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') continue;
    if (argv[i] === '--motion') {
      motionPath = argv[(i += 1)];
      continue;
    }
    files.push(argv[i]);
  }
  if (files.length === 0) {
    process.stderr.write('usage: validate-motion-lean.mjs [--json] [--motion <motion.ndjson>] <file.ndjson> [...]\n');
    return 2;
  }
  const motion = motionPath ? validateMotionLog(readFileSync(motionPath, 'utf8')) : null;

  let failed = false;
  const results = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const kind = detectKind(text);
    if (kind === null) {
      process.stderr.write(`${file}: no motion_* or lean_* record found\n`);
      failed = true;
      continue;
    }
    const { model, ...result } = kind === 'motion' ? validateMotionLog(text) : validateLeanLog(text, { motion });
    results.push({ file, ...result });
    if (!result.ok) failed = true;
    if (asJson) continue;
    const count = kind === 'motion' ? `${result.samples} samples` : `${result.records} records`;
    process.stdout.write(
      `${result.ok ? 'PASS' : 'FAIL'} ${file} [${kind}] - ${count}, ${result.events} events, ` +
        `${result.errorCount} error(s), ${result.warnCount} warning(s)\n`,
    );
    for (const finding of result.findings) {
      process.stdout.write(`  ${finding.severity === ERROR ? 'E' : 'W'} line ${finding.line} ${finding.code}: ${finding.detail}\n`);
    }
  }
  if (asJson) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
