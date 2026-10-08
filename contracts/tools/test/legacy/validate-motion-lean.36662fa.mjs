// FROZEN COPY of contracts/tools/validate-motion-lean.mjs at 36662fa: the C1 in-memory reference that
// Codex accepted (345 checks + four consumer counterexamples). C2 must reproduce its findings exactly on
// every fixture; test/run-differential.mjs compares them. Do not edit except for the schema path.
// Validates the raw motion log and the derived lean log against
// contracts/motion-lean/v1 and v2 (the version is read from the file; a file
// holds exactly one version). The schemas cover one record; this tool adds the
// cross-line rules a schema cannot express: sequence continuity, monotonic
// direction, clock-map references, calibration segmentation and extrema.
// Usage: node validate-motion-lean.mjs [--json] [--motion <motion.ndjson>] [--parent <old.lean.ndjson>] <file.ndjson> [...]
// A lean file is checked against a motion file only when --motion is given.
// Exit codes: 0 pass, 1 errors, 2 usage, 4 unsupported schemaVersion.
// This is the in-memory reference implementation (C1). The bounded, disk-indexed
// engine (C2) must reproduce its results on small inputs.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const here = dirname(fileURLToPath(import.meta.url));
const SUPPORTED_VERSIONS = [1, 2];
let V = 1; // schemaVersion of the file being validated (set per validate call)

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
  'UNSETTLED_SELECTION_WINDOW',
  'AUTO_STATE_TRANSITION_UNSETTLED',
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
const LEAN_FLAGS_V1 = [
  'lean_unavailable',
  'no_valid_calibration',
  'lean_axis_unknown',
  'input_gap',
  'after_input_gap',
  'dynamic_acceleration_high',
  'carried_over_unverified',
  'clock_map_unavailable',
  'synthetic',
  // V1-1: known since the reliability amendment (0003 A.3).
  'sensor_accuracy_unreliable',
  'calibration_input_unverified',
];
// v2 only (0003 B.4, D.4): unknown platform accuracy, unqualified algorithm.
const LEAN_FLAGS_V2_ONLY = ['sensor_accuracy_unknown', 'algorithm_unqualified'];
// An estimate carrying any of these cannot be extremum-eligible.
const BLOCKING_V1 = [
  'lean_unavailable',
  'no_valid_calibration',
  'lean_axis_unknown',
  'input_gap',
  'after_input_gap',
  'dynamic_acceleration_high',
  'sensor_accuracy_unreliable', // V1-2
  'calibration_input_unverified',
];
// Calibration taint (V1-4, V1-5): a calibration carrying one of these taints every estimate using it.
const TAINT_V1 = ['sensor_accuracy_unreliable', 'calibration_input_unverified'];
export const KNOWN_LEAN_FLAGS = new Set(LEAN_FLAGS_V1);
export const KNOWN_LEAN_FLAGS_V2 = new Set([...LEAN_FLAGS_V1, ...LEAN_FLAGS_V2_ONLY]);
export const BLOCKING_LEAN_FLAGS = new Set(BLOCKING_V1);
export const BLOCKING_LEAN_FLAGS_V2 = new Set([...BLOCKING_V1, ...LEAN_FLAGS_V2_ONLY]);
const knownLeanFlags = () => (V === 2 ? KNOWN_LEAN_FLAGS_V2 : KNOWN_LEAN_FLAGS);
const blockingLeanFlags = () => (V === 2 ? BLOCKING_LEAN_FLAGS_V2 : BLOCKING_LEAN_FLAGS);
const taintFlags = () => (V === 2 ? new Set([...TAINT_V1, 'sensor_accuracy_unknown']) : new Set(TAINT_V1));
// Any other leanAxisSource value (including a newer writer's) means "axis unknown".
const USABLE_AXIS_SOURCES = new Set(['manual_left_lean', 'inherited_from_previous']);

const MOTION_RECORD_TYPES = new Set(['motion_sample', 'motion_event']);
const LEAN_RECORD_TYPES = new Set([
  'lean_calibration',
  'lean_estimate',
  'lean_extremum',
  'lean_segment_closed',
  'lean_event',
  'lean_hint',
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
const MOTION_EVENT_DEFS_V2 = {
  selection_anchor: 'eventSelectionAnchor',
  selection_stats: 'eventSelectionStats',
  source_accuracy_state: 'eventSourceAccuracyState',
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
const LEAN_EVENT_DEFS_V2 = {
  auto_reference_reset: 'eventAutoReferenceReset',
  auto_reference_state: 'eventAutoReferenceState',
};
const LEAN_RECORD_DEFS = {
  lean_calibration: 'leanCalibration',
  lean_estimate: 'leanEstimate',
  lean_extremum: 'leanExtremum',
  lean_segment_closed: 'leanSegmentClosed',
  lean_hint: 'leanHint',
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
for (const version of SUPPORTED_VERSIONS) {
  const dir = resolve(here, `../../../motion-lean/v${version}`);
  for (const name of ['common', 'motion', 'lean']) {
    ajv.addSchema(JSON.parse(readFileSync(resolve(dir, `${name}.schema.json`), 'utf8')));
  }
}
const compiled = new Map();
function subSchema(file, name) {
  const key = `${V}#${file}#${name}`;
  if (!compiled.has(key)) {
    compiled.set(key, ajv.getSchema(`https://contracts.roadscope.invalid/motion-lean/v${V}/${file}.schema.json#/$defs/${name}`));
  }
  return compiled.get(key);
}

// The version of a file is that of its first record carrying an integer
// schemaVersion. Absent everywhere, the file is validated as v1 (and every line
// fails its schema anyway).
export function detectSchemaVersion(text) {
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const record = JSON.parse(raw);
      if (record && Number.isInteger(record.schemaVersion)) return record.schemaVersion;
    } catch {
      // keep looking
    }
  }
  return null;
}

function unsupportedResult(kind, version) {
  const report = newReport();
  report.add('UNSUPPORTED_SCHEMA_VERSION', 1, `schemaVersion ${version} is not supported (known: ${SUPPORTED_VERSIONS.join(', ')})`);
  return finish(report, { kind, samples: 0, records: 0, events: 0, unknownRecords: 0, unsupported: true, version });
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
    if (Number.isInteger(record.schemaVersion) && record.schemaVersion !== V) {
      add('SCHEMA_VERSION_MIXED', line, `schemaVersion ${record.schemaVersion} in a schemaVersion ${V} file`);
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
  const version = detectSchemaVersion(text) ?? 1;
  if (!SUPPORTED_VERSIONS.includes(version)) return unsupportedResult('motion', version);
  V = version;
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
    segmentOpen: false, // true between a motion_started and the next session boundary
    sessionOrdinal: -1,
    controlLast: -1,
    sel: new Map(), // sourceId -> selection / accuracy tracking (v2)
    lastSeen: new Map(), // sourceId -> {sequence, boot} of the previous sample
    clockMaps: new Map(), // mapId -> event
    lastMeasurement: new Map(), // sourceId -> Map(bootId -> us)
    lastReceived: new Map(),
    lastTime: new Map(), // sourceId -> {boot, us} for gap detection
    cover: new Map(), // sourceId -> [{boot, from, to}]
    allCover: [],
    lastLine: 1,
  };
  // `breaks` are points where a source's input is not continuous: a replay or
  // an estimate must not straddle one. nextSeq is the first sequence after it.
  // `sessions[i]` holds the declarations of the i-th session: a sample or a
  // reference is judged by the declaration of the session it was written in.
  const model = { version, sequences: new Map(), maxSeq: new Map(), breaks: new Map(), sessions: [], maxControl: -1 };
  let sampleCount = 0;
  let eventCount = 0;

  for (const { record, line } of records(text, MOTION_RECORD_TYPES, add, counters)) {
    state.lastLine = line;
    if (record.recordType === 'motion_event') {
      if (!checkMotionEvent(record, line, add)) {
        // A rejected event still consumed its controlSequence: do not cascade into a gap report.
        if (V === 2 && Number.isInteger(record.controlSequence)) state.controlLast = Math.max(state.controlLast, record.controlSequence);
        continue;
      }
      eventCount += 1;
      applyMotionEvent(state, spaceOf, record, line, add, model);
      continue;
    }
    if (!checkMotionSample(record, line, add)) continue;
    sampleCount += 1;
    applyMotionSample(state, spaceOf(record.sourceId), record, line, add, model);
  }
  if (V === 2) warnUnsettled(state, state.lastLine, add);

  return finish(report, {
    kind: 'motion',
    version,
    samples: sampleCount,
    events: eventCount,
    unknownRecords: counters.unknown,
    model,
  });
}

function warnUnsettled(state, line, add) {
  for (const [sourceId, sel] of state.sel) {
    if (sel.policy && sel.kept > 0) {
      add('UNSETTLED_SELECTION_WINDOW', line, `${sourceId} has ${sel.kept} stored sample(s) after the last selection_stats`);
    }
  }
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
  const defName = MOTION_EVENT_DEFS[record.eventType] ?? (V === 2 ? MOTION_EVENT_DEFS_V2[record.eventType] : undefined);
  if (!defName) {
    add('UNKNOWN_EVENT_TYPE', line, String(record.eventType));
    return true;
  }
  return schemaCheck('motion', defName, record, line, add);
}

// A session ends at a resume, or (v2) at a clock_adjusted that changes the boot.
// v1 also ended it at a UTC-only clock_adjusted. A UTC-only adjustment is not a
// session boundary in v2: it must not reset selection buckets or policies.
function endsSession(record) {
  if (record.eventType === 'recording_resumed') return true;
  if (record.eventType !== 'clock_adjusted') return false;
  return V === 1 || record.previousDeviceBootId !== record.deviceBootId;
}

function newSelection(declaration) {
  return {
    policy: declaration.inputPolicy ?? null,
    anchor: null,
    needAnchor: true,
    // Why an anchor is owed. An anchor that nothing asks for is unjustified: it could move bucket boundaries
    // to let several samples through. 'session' accepts start|resume, the others their own reason.
    causes: new Set(['session']),
    anchorMissingReported: false,
    lastBucket: null,
    lastStored: null, // {boot, timeBase, t} of the last stored sample
    acc: 'unobserved',
    windowIndex: 0,
    kept: 0,
    firstKept: null,
    lastKept: null,
    accTransitions: 0,
    bufferDropped: 0,
    prevPendingOut: null,
  };
}

function applyMotionEvent(state, spaceOf, record, line, add, model) {
  const declaring = record.eventType === 'clock_adjusted' || record.eventType === 'recording_resumed';
  trackBoot(state, record, declaring, line, add);
  if (endsSession(record)) state.segmentOpen = false;

  if (V === 2) {
    const expected = state.controlLast + 1;
    const gapAllowed = record.eventType === 'log_truncated' || record.eventType === 'recording_resumed';
    if (record.controlSequence > expected && !gapAllowed) {
      add('CONTROL_SEQUENCE_GAP', line, `controlSequence ${record.controlSequence}, expected ${expected}`);
    } else if (record.controlSequence < expected) {
      add('CONTROL_SEQUENCE_REGRESSION', line, `controlSequence ${record.controlSequence}, expected ${expected}`);
    }
    state.controlLast = Math.max(state.controlLast, record.controlSequence);
    model.maxControl = state.controlLast;
  }

  for (const [source, last] of Object.entries(record.lastSequences)) {
    const space = spaceOf(source);
    if (last > space.maxSequence) {
      add('EVENT_SEQUENCE_AHEAD', line, `${source}: lastSequences ${last} exceeds last written sample ${space.maxSequence}`);
    }
  }

  switch (record.eventType) {
    case 'motion_started':
      applyMotionStarted(state, record, line, add, model);
      break;
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
      const sel = state.sel.get(record.sourceId);
      if (V === 2 && sel?.policy) {
        sel.needAnchor = true;
        sel.causes.add('clock_epoch');
      }
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
      const sel = state.sel.get(record.sourceId);
      if (V === 2 && sel?.policy) {
        sel.needAnchor = true;
        sel.causes.add('gap');
        if (record.reason === 'buffer_full') sel.bufferDropped += record.droppedCount;
      }
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
    case 'selection_anchor':
      applySelectionAnchor(state, record, line, add);
      break;
    case 'selection_stats':
      applySelectionStats(state, record, line, add);
      break;
    case 'source_accuracy_state':
      applyAccuracyState(state, record, line, add);
      break;
    default:
      break;
  }
}

function applyMotionStarted(state, record, line, add, model) {
  state.started = true;
  const newSession = !state.segmentOpen;
  if (newSession) {
    if (V === 2) warnUnsettled(state, line, add);
    state.sessionOrdinal += 1;
    model.sessions.push(new Map());
    state.sel = new Map();
  }
  const sessionDecls = model.sessions[state.sessionOrdinal];
  for (const source of record.sources) {
    // A repeated motion_started inside one session must not rewrite a clock
    // state that source_clock_state events own.
    const current = state.clockState.get(source.sourceId);
    if (state.segmentOpen && current !== undefined && current !== source.measurementClock) {
      add('SOURCE_CLOCK_REDECLARED', line, `${source.sourceId} ${current} -> ${source.measurementClock} without source_clock_state`);
    } else {
      state.clockState.set(source.sourceId, source.measurementClock);
    }
    if (!source.available) continue;
    if (V === 2) {
      const hasPolicy = source.inputPolicy !== undefined;
      if ((!hasPolicy && source.storageStride === null) || (hasPolicy && source.storageStride === 1)) {
        add('STRIDE_POLICY_CONFLICT', line, `${source.sourceId}: inputPolicy ${hasPolicy ? 'present' : 'absent'} with storageStride ${source.storageStride}`);
      }
      const before = sessionDecls.get(source.sourceId);
      if (!newSession && before) {
        for (const field of ['inputPolicy', 'storageStride', 'gapThresholdUs', 'requestedSamplingPeriodUs']) {
          if (canonicalJson(before[field] ?? null) !== canonicalJson(source[field] ?? null)) {
            add('POLICY_REDECLARED', line, `${source.sourceId}.${field} changed inside one session`);
          }
        }
      } else {
        state.sel.set(source.sourceId, newSelection(source));
      }
    }
    sessionDecls.set(source.sourceId, source);
  }
  state.segmentOpen = true;
  state.declared = new Map(record.sources.map((s) => [s.sourceId, s]));
}

function applySelectionAnchor(state, record, line, add) {
  const sel = state.sel.get(record.sourceId);
  if (!sel?.policy) {
    add('SELECTION_WITHOUT_POLICY', line, `${record.sourceId} declares no inputPolicy in this session`);
    return;
  }
  if (record.policyVersion !== sel.policy.policyVersion) {
    add('SELECTION_STATS_MISMATCH', line, `selection_anchor policyVersion ${record.policyVersion} != declared ${sel.policy.policyVersion}`);
  }
  const expected = state.clockState.get(record.sourceId) === 'elapsed_realtime' ? 'measurement' : 'received';
  if (record.timeBase !== expected) {
    add('ANCHOR_TIMEBASE_MISMATCH', line, `${record.sourceId} clock is ${state.clockState.get(record.sourceId)}: timeBase must be ${expected}`);
  }
  const justified =
    (sel.causes.has('session') && (record.reason === 'start' || record.reason === 'resume')) ||
    (sel.causes.has('clock_epoch') && record.reason === 'clock_epoch') ||
    (sel.causes.has('gap') && record.reason === 'gap');
  if (!justified) {
    add('SELECTION_ANCHOR_UNJUSTIFIED', line, `${record.sourceId} anchor (reason ${record.reason}) with nothing owed (pending: ${[...sel.causes].join(', ') || 'none'})`);
  }
  // A new anchor may not reach back before the last stored sample of the same boot and time base.
  const last = sel.lastStored;
  if (last && last.boot === record.deviceBootId && last.timeBase === record.timeBase && record.anchorUs < last.t) {
    add('SELECTION_ANCHOR_REGRESSION', line, `${record.sourceId} anchorUs ${record.anchorUs} precedes the last stored sample at ${last.t}`);
  }
  sel.anchor = { timeBase: record.timeBase, anchorUs: record.anchorUs };
  sel.causes = new Set();
  sel.needAnchor = false;
  sel.anchorMissingReported = false;
  sel.lastBucket = null;
}

function applyAccuracyState(state, record, line, add) {
  const sel = state.sel.get(record.sourceId);
  if (!state.declared.get(record.sourceId)?.available || !sel) {
    add('SOURCE_NOT_DECLARED', line, `${record.sourceId} is not an available source of the latest motion_started`);
    return;
  }
  if (sel.acc !== record.previousAccuracyState || record.previousAccuracyState === record.accuracyState) {
    add('ACCURACY_STATE_CHAIN', line, `${record.sourceId} is ${sel.acc}; event claims ${record.previousAccuracyState} -> ${record.accuracyState}`);
    return;
  }
  sel.acc = record.accuracyState;
  sel.accTransitions += 1;
}

function applySelectionStats(state, record, line, add) {
  const sel = state.sel.get(record.sourceId);
  if (!sel?.policy) {
    add('SELECTION_WITHOUT_POLICY', line, `${record.sourceId} declares no inputPolicy in this session`);
    return;
  }
  const mismatch = (detail) => add('SELECTION_STATS_MISMATCH', line, `${record.sourceId} window ${record.windowIndex}: ${detail}`);
  if (record.policyVersion !== sel.policy.policyVersion) mismatch(`policyVersion ${record.policyVersion} != declared ${sel.policy.policyVersion}`);
  if (record.windowIndex !== sel.windowIndex) mismatch(`windowIndex ${record.windowIndex}, expected ${sel.windowIndex}`);
  if (record.keptCount !== sel.kept) mismatch(`keptCount ${record.keptCount} != ${sel.kept} samples stored in the window`);
  if (record.firstKeptSequence !== sel.firstKept || record.lastKeptSequence !== sel.lastKept) {
    mismatch(`kept range ${record.firstKeptSequence}..${record.lastKeptSequence} != stored ${sel.firstKept}..${sel.lastKept}`);
  }
  if (record.observedAccuracyTransitions !== null && record.observedAccuracyTransitions !== sel.accTransitions) {
    mismatch(`observedAccuracyTransitions ${record.observedAccuracyTransitions} != ${sel.accTransitions} source_accuracy_state event(s)`);
  }
  if (record.complete) {
    const received = record.receivedCount + record.pendingIn;
    const settled =
      record.keptCount + record.skippedIntentionalCount + record.invalidCount +
      record.nonmonotonicCount + record.bufferDroppedCount + record.pendingOut;
    if (received !== settled) mismatch(`receivedCount + pendingIn = ${received} but settled + pendingOut = ${settled}`);
    if (record.bufferDroppedCount !== sel.bufferDropped) {
      mismatch(`bufferDroppedCount ${record.bufferDroppedCount} != ${sel.bufferDropped} dropped by samples_dropped(buffer_full)`);
    }
    if (sel.prevPendingOut !== null && record.pendingIn !== sel.prevPendingOut) {
      mismatch(`pendingIn ${record.pendingIn} != previous window pendingOut ${sel.prevPendingOut}`);
    }
  }
  sel.prevPendingOut = record.complete ? record.pendingOut : null;
  sel.windowIndex += 1;
  sel.kept = 0;
  sel.firstKept = null;
  sel.lastKept = null;
  sel.accTransitions = 0;
  sel.bufferDropped = 0;
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
  if (V === 2) checkSelection(state, record, line, add);

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
  model.maxSeq.set(record.sourceId, Math.max(model.maxSeq.get(record.sourceId) ?? -1, record.sequence));
  model.sequences.get(record.sourceId).set(record.sequence, {
    boot: record.deviceBootId,
    measurementUs: measured,
    session: state.sessionOrdinal,
    controlSeqBefore: state.controlLast,
  });
}

// v2 time-bucket selection and accuracy bookkeeping for one stored sample.
function checkSelection(state, record, line, add) {
  const sel = state.sel.get(record.sourceId);
  if (!sel) return;
  const sampleState = record.accuracyLevel === null ? 'unavailable' : record.accuracyLevel;
  if (sel.policy) {
    if (sampleState !== sel.acc) {
      add('ACCURACY_CHANGE_UNRECORDED', line, `${record.sourceId} accuracy is ${sampleState} but the last recorded state is ${sel.acc}: no source_accuracy_state between`);
      sel.acc = sampleState;
    }
    if (sel.needAnchor || !sel.anchor) {
      if (!sel.anchorMissingReported) {
        add('SELECTION_ANCHOR_MISSING', line, `${record.sourceId} stores a sample with no selection_anchor in force for this clock epoch`);
        sel.anchorMissingReported = true;
      }
    } else {
      const t = sel.anchor.timeBase === 'measurement' ? record.measurementMonotonicUs : record.receivedMonotonicUs;
      if (t !== null) {
        if (t < sel.anchor.anchorUs) {
          // Never skipped silently: a sample before its anchor cannot be placed in any bucket.
          add('SELECTION_SAMPLE_BEFORE_ANCHOR', line, `${record.sourceId} sample at ${t} precedes its anchor ${sel.anchor.anchorUs}`);
        } else {
          const bucket = Math.floor((t - sel.anchor.anchorUs) / sel.policy.periodUs);
          if (sel.lastBucket !== null && bucket === sel.lastBucket) {
            add('SELECTION_BUCKET_VIOLATION', line, `${record.sourceId} stored two samples in bucket ${bucket} (periodUs ${sel.policy.periodUs})`);
          }
          sel.lastBucket = bucket;
        }
        sel.lastStored = { boot: record.deviceBootId, timeBase: sel.anchor.timeBase, t };
      }
    }
    sel.kept += 1;
    sel.firstKept ??= record.sequence;
    sel.lastKept = record.sequence;
  }
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

export function validateLeanLog(text, { motion = null, parent = null } = {}) {
  const version = detectSchemaVersion(text) ?? 1;
  if (!SUPPORTED_VERSIONS.includes(version)) return unsupportedResult('lean', version);
  V = version;
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
    // v2
    runId: null,
    experimental: false,
    startedRecord: null,
    afterCursor: new Map(), // sourceId -> highest afterInputs sequence seen on hints / auto events
    auto: { current: null, resetSinceState: false, hintFirstSinceReset: null, hintLast: -1, sawState: false, violation: false, owed: null, owedReported: false },
    lastLine: 1,
  };
  let recordCount = 0;
  let eventCount = 0;

  if (motion && motion.version !== V) {
    add('SCHEMA_VERSION_MIXED', 1, `lean is schemaVersion ${V} but the motion log is schemaVersion ${motion.version}`);
    motion = null;
  }

  for (const { record, line } of records(text, LEAN_RECORD_TYPES, add, counters)) {
    state.lastLine = line;
    if (V === 2 && !checkRunId(state, record, line, add)) continue;
    if (record.recordType === 'lean_event') {
      if (!checkLeanEvent(record, line, add)) continue;
      eventCount += 1;
      applyLeanEvent(state, spaceOf, record, line, add, motion);
      continue;
    }
    if (!checkLeanRecord(record, line, add)) continue;
    recordCount += 1;
    for (const flag of record.qualityFlags) {
      if (!knownLeanFlags().has(flag)) add('UNKNOWN_QUALITY_FLAG', line, flag);
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
      case 'lean_hint':
        applyHint(state, record, line, add, motion);
        break;
      default:
        applySegmentClosed(state, record, line, add);
    }
  }
  if (V === 2) finishLeanV2(state, add, motion, parent);

  return finish(report, {
    kind: 'lean',
    version,
    records: recordCount,
    events: eventCount,
    unknownRecords: counters.unknown,
    pairedWithMotion: motion !== null,
    crossFileChecks: {
      motion: motion !== null ? 'run' : 'not_run',
      parent: state.startedRecord?.derivesFrom ? (parent ? 'run' : 'not_run') : 'not_applicable',
    },
  });
}

// v2: one lean file holds exactly one leanRunId, and every line carries it.
function checkRunId(state, record, line, add) {
  if (typeof record.leanRunId !== 'string') return true; // the schema reports a missing id
  if (state.runId === null) {
    state.runId = record.leanRunId;
    return true;
  }
  if (record.leanRunId !== state.runId) {
    add('RUN_ID_MISMATCH', line, `leanRunId ${record.leanRunId} in a file of run ${state.runId}`);
    return false;
  }
  return true;
}

function finishLeanV2(state, add, motion, parent) {
  const auto = state.auto;
  const scope = state.startedRecord?.replayScope;
  settleAtBoundary(state, add, state.lastLine, 'end of file');
  if (scope?.calibration && (auto.violation || !auto.sawState || auto.current === null)) {
    add('CALIBRATION_REPLAY_STATE_INCOMPLETE', state.lastLine, 'replayScope.calibration is true but the auto_reference_state history is missing or inconsistent');
  }
  const config = state.startedRecord?.qualification?.qualifiedConfiguration;
  if (motion && config && state.startedRecord.qualification.status === 'qualified') {
    // A qualified claim binds the whole file: every configured input must be declared available, and
    // identical to the configuration, in every motion session. Absence is a mismatch, never a skip.
    const reported = new Set();
    for (const input of config.inputs) {
      motion.model.sessions.forEach((decls, session) => {
        const decl = decls.get(input.sourceId);
        const actual = decl?.available
          ? { sourceId: decl.sourceId, sensorType: decl.sensorType, inputPolicy: decl.inputPolicy ?? null, storageStride: decl.storageStride }
          : null;
        if ((actual === null || canonicalJson(actual) !== canonicalJson(input)) && !reported.has(input.sourceId)) {
          reported.add(input.sourceId);
          add('QUALIFIED_CONFIG_MISMATCH', state.startedRecord.line ?? 1, `qualifiedConfiguration input ${input.sourceId} is ${actual === null ? 'not declared available' : 'declared differently'} in motion session ${session}`);
        }
      });
    }
  }
  const parentInfo = state.startedRecord?.derivesFrom;
  if (parentInfo && parent) {
    const prefix = parent.subarray(0, parentInfo.parentByteLength);
    const sha = createHash('sha256').update(prefix).digest('hex');
    if (parent.length < parentInfo.parentByteLength || sha !== parentInfo.parentPrefixSha256) {
      add('DERIVED_RUN_PARENT_MISMATCH', 1, 'parent prefix length or SHA-256 differs from derivesFrom');
    }
  }
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
  const defName = LEAN_EVENT_DEFS[record.eventType] ?? (V === 2 ? LEAN_EVENT_DEFS_V2[record.eventType] : undefined);
  if (!defName) {
    add('UNKNOWN_EVENT_TYPE', line, String(record.eventType));
    return true;
  }
  return schemaCheck('lean', defName, record, line, add);
}

function applyLeanEvent(state, spaceOf, record, line, add, motion) {
  const declaring = record.eventType === 'clock_adjusted' || record.eventType === 'recording_resumed';
  trackBoot(state, record, declaring, line, add);

  if (V === 2) {
    for (const [source, last] of Object.entries(record.lastSequences)) {
      if (last > spaceOf(source).maxSequence) {
        add('EVENT_SEQUENCE_AHEAD', line, `${source}: lastSequences ${last} exceeds last written record ${spaceOf(source).maxSequence}`);
      }
    }
  } else if (record.lastSequence > spaceOf(record.sourceId).maxSequence) {
    add('EVENT_SEQUENCE_AHEAD', line, `lastSequence ${record.lastSequence} exceeds last written record ${spaceOf(record.sourceId).maxSequence}`);
  }
  if (record.eventType === 'lean_started') {
    state.started = true;
    state.policy = record.extremumPolicy;
    state.replayable = record.replayable;
    if (V === 2) applyLeanStartedV2(state, record, line, add);
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
    if (V === 2 && motion && record.initialControlCursor > motion.model.maxControl) {
      add('CONTROL_CURSOR_AHEAD', line, `initialControlCursor ${record.initialControlCursor} exceeds the motion log's last controlSequence ${motion.model.maxControl}`);
    }
  }
  if (record.eventType === 'estimator_state') {
    if (record.state === 'unavailable') {
      state.unavailable = true;
      // The estimator interruption blocks the automatic reference: a transition to disabled is owed.
      if (V === 2 && state.auto.current === 'enabled' && !state.auto.owed) openObligation(state.auto, 'estimator_unavailable');
    } else if (state.unavailable) {
      // Coming back needs a fresh epoch: the fusion state did not survive.
      state.unavailable = false;
      state.resumeAfterEpoch = state.currentEpoch ?? -1;
    }
  }
  if (record.eventType === 'log_truncated' || record.eventType === 'recording_resumed') {
    if (V === 2) {
      for (const [source, next] of Object.entries(record.resumedSequences)) spaceOf(source).expectedNext = next;
      if (record.eventType === 'recording_resumed') {
        settleAtBoundary(state, add, line, 'recording_resumed');
        if (state.startedRecord?.replayScope?.calibration && state.auto.current === null) state.auto.violation = true;
        state.auto.current = null; // the pipeline is rebuilt: the initial state must be stored again
        state.auto.resetSinceState = false;
      }
    } else {
      spaceOf(record.sourceId).expectedNext = record.resumedSequence;
    }
  }
  if (record.eventType === 'calibration_invalidated') {
    const calibration = state.calibrations.get(record.calibrationId);
    if (!calibration) {
      add('CALIBRATION_UNKNOWN', line, `calibration_invalidated names unknown ${record.calibrationId}`);
    } else {
      calibration.invalidatedAt = record.invalidatedAtMonotonicUs;
    }
  }
  if (record.eventType === 'auto_reference_reset') applyAutoReset(state, record, line, add, motion);
  if (record.eventType === 'auto_reference_state') applyAutoState(state, record, line, add, motion);
}

function applyLeanStartedV2(state, record, line, add) {
  settleAtBoundary(state, add, line, 'lean_started');
  state.startedRecord = { ...record, line };
  // violation is irrevocable: a new lean_started rebuilds the pipeline but does not repair the history before it.
  state.auto = { current: null, resetSinceState: false, hintFirstSinceReset: null, hintLast: state.auto.hintLast, sawState: state.auto.sawState, violation: state.auto.violation, owed: null, owedReported: false };
  const ids = record.inputSources.map((i) => i.sourceId);
  if (new Set(ids).size !== ids.length) add('INPUT_SOURCES_INVALID', line, 'inputSources names a source more than once');
  if (record.replayable !== record.replayScope.estimate) {
    add('REPLAY_SCOPE_MISMATCH', line, `replayable ${record.replayable} != replayScope.estimate ${record.replayScope.estimate}`);
  }
  if (record.replayScope.refilter) {
    add('REFILTER_SPEC_UNRESOLVABLE', line, 'replayScope.refilter is true but this contract revision defines no filter_spec');
  }
  const q = record.qualification;
  state.experimental = q.status === 'experimental';
  if (q.status === 'qualified') {
    if (q.qualificationRef === null) add('QUALIFIED_WITHOUT_REF', line, 'qualified run has no qualificationRef');
    if (q.qualifiedConfiguration === null || q.configurationFingerprint === null) {
      add('QUALIFICATION_FINGERPRINT_MISMATCH', line, 'qualified run must carry qualifiedConfiguration and configurationFingerprint');
    } else {
      const sha = createHash('sha256').update(canonicalJson(q.qualifiedConfiguration)).digest('hex');
      if (sha !== q.configurationFingerprint) {
        add('QUALIFICATION_FINGERPRINT_MISMATCH', line, 'configurationFingerprint is not the SHA-256 of the canonical qualifiedConfiguration');
      }
      const c = q.qualifiedConfiguration;
      const declared = record.inputSources.map((i) => i.sourceId);
      const configured = c.inputs.map((i) => i.sourceId);
      const sameSet = new Set(declared).size === new Set(configured).size && declared.every((id) => configured.includes(id));
      if (new Set(configured).size !== configured.length || !sameSet) {
        add('QUALIFIED_CONFIG_MISMATCH', line, `qualifiedConfiguration inputs [${configured.join(', ')}] differ from lean_started inputSources [${declared.join(', ')}] (missing, extra or duplicate source)`);
      }
      if (
        c.algorithmVersion !== record.algorithmVersion ||
        canonicalJson(c.extremumPolicy) !== canonicalJson(record.extremumPolicy) ||
        c.autoReferenceConfigFingerprint !== record.autoReferenceConfigFingerprint
      ) {
        add('QUALIFIED_CONFIG_MISMATCH', line, 'qualifiedConfiguration differs from the algorithmVersion, extremumPolicy or autoReferenceConfigFingerprint declared by lean_started');
      }
    }
  }
}

// ---- automatic reference control (0003 D.1a)

// Owed transitions. An estimator interruption while the automatic reference is enabled opens an
// obligation that ONLY auto_reference_reset + auto_reference_state(disabled, <reason>) settles. A later
// enabled, another state, another reason or a recovered estimator never clears it: "the condition is
// over" is not "the control history is complete".
function openObligation(auto, reason) {
  auto.owed = reason;
  auto.owedReported = false;
}

// Inside one pipeline, anything written while the obligation is open proves the transition was not stored.
function reportObligation(state, add, line, detail) {
  const auto = state.auto;
  auto.violation = true;
  if (!auto.owedReported) {
    add('AUTO_STATE_TRANSITION_MISSING', line, detail);
    auto.owedReported = true;
  }
}

// A resume, a new lean_started or the end of the file may legitimately cut the writer off before it
// stored the transition (a crash). The file stays valid data, but the gap is kept as an irrevocable
// violation: the automatic reference's history cannot be replayed across it.
function settleAtBoundary(state, add, line, boundary) {
  const auto = state.auto;
  if (!auto.owed) return;
  auto.violation = true;
  if (!auto.owedReported) add('AUTO_STATE_TRANSITION_UNSETTLED', line, `${boundary} while disabled(${auto.owed}) was still owed`);
  auto.owed = null;
  auto.owedReported = false;
}

function checkAfterInputs(state, record, line, add, motion) {
  for (const { sourceId, sequence } of record.afterInputs) {
    const previous = state.afterCursor.get(sourceId);
    if (previous !== undefined && sequence < previous) {
      add('HINT_CURSOR_REGRESSION', line, `afterInputs ${sourceId} ${sequence} < ${previous}`);
    }
    if (motion && sequence > (motion.model.maxSeq.get(sourceId) ?? -1)) {
      add('HINT_CURSOR_AHEAD', line, `afterInputs ${sourceId} ${sequence} exceeds the motion log's last sequence`);
    }
    state.afterCursor.set(sourceId, Math.max(previous ?? -1, sequence));
  }
}

function calibrationActive(state, boot) {
  const calibration = state.currentId ? state.calibrations.get(state.currentId) : null;
  return Boolean(
    calibration && calibration.invalidatedAt === null && !state.closed.has(calibration.calibrationId) &&
      (boot === undefined || calibration.deviceBootId === boot),
  );
}

function applyAutoReset(state, record, line, add, motion) {
  checkAfterInputs(state, record, line, add, motion);
  state.auto.resetSinceState = true;
  state.auto.hintFirstSinceReset = null;
}

function applyAutoState(state, record, line, add, motion) {
  checkAfterInputs(state, record, line, add, motion);
  const auto = state.auto;
  const previous = auto.current;
  const fail = (code, detail) => {
    auto.violation = true;
    add(code, line, detail);
  };
  if (record.state === 'suspended' && record.reason === 'manual_command_started' && !auto.resetSinceState) {
    fail('AUTO_RESET_MISSING', 'entering a manual command must be preceded by auto_reference_reset');
  }
  if (previous === 'suspended' && record.state !== 'suspended' && !auto.resetSinceState) {
    fail('AUTO_RESUME_WITHOUT_RESET', `leaving suspended (${record.state}) without auto_reference_reset`);
  }
  if (record.state === 'enabled' && (calibrationActive(state, record.deviceBootId) || state.unavailable)) {
    fail('AUTO_ENABLED_WHILE_BLOCKED', `enabled while ${state.unavailable ? 'the estimator is unavailable' : 'a calibration is in force'}`);
  }
  // An estimator interruption resets the fusion state, so the reset precedes the disabled transition.
  if (record.state === 'disabled' && record.reason === 'estimator_unavailable' && !auto.resetSinceState) {
    fail('AUTO_RESET_MISSING', 'disabled(estimator_unavailable) must be preceded by auto_reference_reset');
  }
  if (auto.owed) {
    if (record.state === 'disabled' && record.reason === auto.owed) auto.owed = null; // settled
    else reportObligation(state, add, line, `auto_reference_state(${record.state}, ${record.reason}) while disabled(${auto.owed}) is owed: only reset + disabled(${auto.owed}) settles it`);
  }
  auto.current = record.state;
  auto.resetSinceState = false;
  auto.sawState = true;
}

function applyHint(state, record, line, add, motion) {
  checkAfterInputs(state, record, line, add, motion);
  const auto = state.auto;
  if (state.unavailable) {
    // The file itself says the estimator is unavailable: an older `enabled` cannot make this hint acceptable.
    auto.violation = true;
    add('HINT_WHILE_ESTIMATOR_UNAVAILABLE', line, 'lean_hint while estimator_state is unavailable');
  }
  if (auto.owed) reportObligation(state, add, line, `lean_hint while disabled(${auto.owed}) is owed`);
  if (auto.current === null) {
    auto.violation = true;
    add('AUTO_STATE_MISSING', line, 'lean_hint before any auto_reference_state since lean_started / recording_resumed');
  } else if (auto.current !== 'enabled') {
    auto.violation = true;
    add('HINT_WHILE_NOT_ENABLED', line, `lean_hint while the automatic reference is ${auto.current}`);
  }
  if (calibrationActive(state, record.deviceBootId)) {
    auto.violation = true;
    add('HINT_WHILE_CALIBRATED', line, 'lean_hint while a calibration is in force');
  }
  auto.hintFirstSinceReset ??= record.sequence;
  auto.hintLast = Math.max(auto.hintLast, record.sequence);
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
  if (record.origin === 'carried_over') {
    const source = state.calibrations.get(record.carriedOverFromCalibrationId);
    if (source) {
      const taint = taintFlags();
      const lost = source.qualityFlags.filter((flag) => taint.has(flag) && !record.qualityFlags.includes(flag));
      if (lost.length > 0) add('CARRIED_OVER_TAINT_DROPPED', line, `carried_over calibration dropped ${lost.join(', ')} from ${source.calibrationId}`);
    }
  }
  if (V === 2 && record.evidence?.kind === 'auto_straight') checkHintRange(state, record, line, add);
  if (record.supersedesCalibrationId !== null && state.calibrations.has(record.supersedesCalibrationId)) {
    state.calibrations.get(record.supersedesCalibrationId).supersededBy = record.calibrationId;
  }
  state.calibrations.set(record.calibrationId, { ...record, invalidatedAt: null, supersededBy: null });
  state.currentId = record.calibrationId;
}

// An automatic calibration must cite every hint consumed since the last reset.
function checkHintRange(state, record, line, add) {
  const { firstHintSequence, lastHintSequence } = record.evidence.hintRange;
  const auto = state.auto;
  if (auto.hintFirstSinceReset === null || firstHintSequence !== auto.hintFirstSinceReset || lastHintSequence !== auto.hintLast) {
    add('HINT_RANGE_INCOMPLETE', line, `hintRange ${firstHintSequence}..${lastHintSequence} must equal the hints since the last reset (${auto.hintFirstSinceReset}..${auto.hintLast})`);
  }
  if (lastHintSequence > auto.hintLast) add('HINT_AFTER_CALIBRATION', line, `hintRange names hint ${lastHintSequence} that is written later`);
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
    const blocking = [...flags].filter((flag) => blockingLeanFlags().has(flag));
    if (record.leanAngleDeg === null || blocking.length > 0) {
      add('EXTREMUM_ELIGIBLE_BLOCKED', line, `extremumEligible with ${record.leanAngleDeg === null ? 'null angle' : blocking.join(', ')}`);
    }
  }

  if (V === 2 && state.experimental) {
    if (!flags.has('algorithm_unqualified')) add('EXPERIMENTAL_ESTIMATE_UNFLAGGED', line, 'estimate of an experimental run must carry algorithm_unqualified');
    if (record.extremumEligible) add('EXTREMUM_IN_EXPERIMENTAL_RUN', line, 'an experimental run has no extremum-eligible estimate');
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
      // V1-4: a tainted calibration taints every estimate that uses it, eligible or not.
      const taint = taintFlags();
      if (calibration.qualityFlags.some((flag) => taint.has(flag)) && !flags.has('calibration_input_unverified')) {
        add('ESTIMATE_CALIBRATION_TAINT_DROPPED', line, `calibration ${calibration.calibrationId} carries ${calibration.qualityFlags.filter((f) => taint.has(f)).join(', ')} but the estimate lacks calibration_input_unverified`);
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
  let newestSample = null;
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
    // The session of a reference is that of the raw sample, by its position in the motion file.
    if (first.session !== last.session) {
      add('SOURCE_REF_SPANS_SESSIONS', line, `${ref.sourceId} ${ref.firstSequence}..${ref.lastSequence} spans motion sessions ${first.session} and ${last.session}`);
      continue;
    }
    if (last.measurementUs === null) {
      add('SOURCE_REF_NO_MEASUREMENT_TIME', line, `${ref.sourceId} sequence ${ref.lastSequence} has no measurement time; receive time may not stand in for it`);
      continue;
    }
    if (last.measurementUs > newestInput || (last.measurementUs === newestInput && last.controlSeqBefore > newestSample.controlSeqBefore)) {
      newestSample = last;
    }
    newestInput = Math.max(newestInput, last.measurementUs);
    const breaks = (motion.model.breaks.get(ref.sourceId) ?? []).filter((b) => b.boot === record.deviceBootId);
    if (breaks.some((b) => ref.firstSequence < b.nextSeq && b.nextSeq <= ref.lastSequence)) spansBreak = true;
    if (state.replayable && record.leanAngleDeg !== null) checkReplay(record, ref, samples, breaks, line, add, motion, state, last.session);
  }
  if (newestInput >= 0 && newestInput !== record.measurementMonotonicUs) {
    add('ESTIMATE_TIME_MISMATCH', line, `measurementMonotonicUs ${record.measurementMonotonicUs} != newest referenced input ${newestInput}`);
  }
  if (spansBreak && !(record.leanAngleDeg === null && record.qualityFlags.includes('input_gap'))) {
    add('ESTIMATE_SPANS_GAP', line, 'referenced inputs span a recorded gap, clock change or boot change: the angle must be null with input_gap');
  }
  if (V === 2) {
    if (record.motionControlCursor > motion.model.maxControl) {
      add('CONTROL_CURSOR_AHEAD', line, `motionControlCursor ${record.motionControlCursor} exceeds the motion log's last controlSequence ${motion.model.maxControl}`);
    } else if (newestSample && record.motionControlCursor !== newestSample.controlSeqBefore) {
      add('CONTROL_CURSOR_MISMATCH', line, `motionControlCursor ${record.motionControlCursor}, but the events before the newest input end at ${newestSample.controlSeqBefore}`);
    }
  }
}

// Fusion has history: an estimate depends on every input since its epoch
// boundary, not just on the newest referenced samples.
function checkReplay(record, ref, samples, breaks, line, add, motion, state, session) {
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
  // V1-3: the stride is that of the session the referenced samples were written in,
  // reported at most once per (source, session).
  const stride = motion.model.sessions[session]?.get(ref.sourceId)?.storageStride ?? 1;
  const key = `${ref.sourceId}|${session}`;
  if (stride !== null && stride > 1 && !state.strideReported.has(key)) {
    state.strideReported.add(key);
    add('REPLAY_STRIDE_DROPS_INPUTS', line, `${ref.sourceId} storageStride ${stride} (session ${session}) discards inputs the filter used, yet replayable is true`);
  }
}

function applyExtremum(state, record, line, add) {
  if (V === 2 && state.experimental) add('EXTREMUM_IN_EXPERIMENTAL_RUN', line, 'an experimental run writes no lean_extremum');
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
  let parentPath = null;
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') continue;
    if (argv[i] === '--motion') {
      motionPath = argv[(i += 1)];
      continue;
    }
    if (argv[i] === '--parent') {
      parentPath = argv[(i += 1)];
      continue;
    }
    files.push(argv[i]);
  }
  if (files.length === 0) {
    process.stderr.write('usage: validate-motion-lean.mjs [--json] [--motion <motion.ndjson>] [--parent <old.lean.ndjson>] <file.ndjson> [...]\n');
    return 2;
  }
  const motion = motionPath ? validateMotionLog(readFileSync(motionPath, 'utf8')) : null;
  const parent = parentPath ? readFileSync(parentPath) : null;

  let failed = false;
  let unsupported = false;
  const results = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const kind = detectKind(text);
    if (kind === null) {
      process.stderr.write(`${file}: no motion_* or lean_* record found\n`);
      failed = true;
      continue;
    }
    const { model, ...result } = kind === 'motion' ? validateMotionLog(text) : validateLeanLog(text, { motion, parent });
    results.push({ file, ...result });
    if (!result.ok) failed = true;
    if (result.unsupported) unsupported = true;
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
  if (unsupported) return 4;
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
