#!/usr/bin/env node
// Deterministic, streaming generator of large synthetic schemaVersion 2 motion/lean logs for the C2
// capacity cases (0003 E.5). Never reads private data; holds nothing proportional to the output.
//   node test/gen-synthetic-large.mjs --profile <name> --bytes <motion bytes> --out <dir> [--seed n]
// Writes <dir>/motion.ndjson and <dir>/lean.ndjson (a lean run that cites the motion samples) and
// prints the expected outcome as JSON. Profiles:
//   valid            three sources (two time-bucket, one full-store), anchors, stats, clock maps; lean pair
//   tail-corrupt     valid, then a final half-written line                    -> NOT_JSON on the last line
//   long-duplicate   valid, then a key-reordered copy of sample 0 and a changed copy of sample 1
//                                                                              -> SEQUENCE_DUPLICATE + SEQUENCE_CONFLICT (+ regressions)
//   session-churn    a new session every 2000 samples, alternating full-store and time-bucket policies
//   dangling-refs    valid, but the last lean estimates cite samples the motion log never wrote
//                                                                              -> SOURCE_REF_UNRESOLVED
//   clock-churn      a same-boot clock_adjusted and a new clock_map every second
//   many-findings    every accelerometer sample carries an unknown flag (warning) and every 10th a
//                    measurement after its callback (error)                  -> millions of findings

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const profile = args.profile ?? 'valid';
const targetBytes = Number(args.bytes ?? 64 * 2 ** 20);
const outDir = args.out ?? '.';
let seed = Number(args.seed ?? 1);
const random = () => {
  // xorshift32: deterministic across platforms
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};

class Out {
  constructor(path) {
    this.fd = openSync(path, 'w');
    this.parts = [];
    this.size = 0;
    this.bytes = 0;
    this.lines = 0;
  }

  line(obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    this.parts.push(text, '\n');
    this.size += text.length + 1;
    this.bytes += Buffer.byteLength(text) + 1;
    this.lines += 1;
    if (this.size >= 1 << 20) this.flush();
  }

  raw(text) {
    this.parts.push(text);
    this.bytes += Buffer.byteLength(text);
    this.flush();
  }

  flush() {
    writeSync(this.fd, this.parts.join(''));
    this.parts = [];
    this.size = 0;
  }

  close() {
    this.flush();
    closeSync(this.fd);
  }
}

mkdirSync(outDir, { recursive: true });
const motion = new Out(join(outDir, 'motion.ndjson'));
const lean = new Out(join(outDir, 'lean.ndjson'));

const REC = 'r-synthetic-large';
const BOOT = 'boot-synthetic';
const T0 = 1_000_000_000;
const ANCHOR_MS = 1_791_000_000_000;
const utc = (us) => new Date(ANCHOR_MS + us / 1000).toISOString();
const POLICY = { kind: 'time_bucket_first', periodUs: 20000, policyVersion: 'tbf-1', lossy: true, verifiedAnchorRule: 'first_verified_measurement', unverifiedRule: 'received_time_bucket' };
const SOURCES = [
  { sourceId: 'android-accelerometer', sensorType: 'accelerometer', values: () => ({ xMps2: +(random() - 0.5).toFixed(4), yMps2: +(random() - 0.5).toFixed(4), zMps2: 9.81 }) },
  { sourceId: 'android-gyroscope', sensorType: 'gyroscope', values: () => ({ xRadPerS: +(random() * 0.02).toFixed(5), yRadPerS: 0, zRadPerS: -0.01 }) },
  { sourceId: 'android-game-rotation-vector', sensorType: 'attitude', values: () => ({ qw: 1, qx: 0, qy: 0, qz: 0 }) },
];
const ACC = SOURCES[0].sourceId;

let ctl = 0;
let mapId = 0;
let now = T0 - 100000;
const seq = new Map(SOURCES.map((s) => [s.sourceId, 0]));
const lastSequences = () => Object.fromEntries(SOURCES.map((s) => [s.sourceId, seq.get(s.sourceId) - 1]));
const event = (eventType, fields) =>
  motion.line({ schemaVersion: 2, recordType: 'motion_event', eventType, recordingId: REC, deviceBootId: BOOT, occurredAtUtc: utc(now), occurredMonotonicUs: now, lastSequences: lastSequences(), controlSequence: ctl++, ...fields });

const bucketed = (i, session) => (profile === 'session-churn' ? session % 2 === 1 : i < 2);
function declare(session) {
  return SOURCES.map((s, i) => {
    const d = { sourceId: s.sourceId, sensorType: s.sensorType, platformFused: s.sensorType === 'attitude', available: true, measurementClock: 'elapsed_realtime', axisFrame: 'android_sensor', requestedSamplingPeriodUs: 20000, maxReportLatencyUs: 0, storageStride: 1, gapThresholdUs: 100000 };
    if (s.sensorType === 'attitude') d.attitudeReference = 'game_rotation_vector';
    if (bucketed(i, session)) {
      d.storageStride = null;
      d.inputPolicy = POLICY;
    }
    return d;
  });
}

// window bookkeeping per bucketed source
const windows = new Map();
function startSession(session, reason) {
  event('motion_started', { platform: 'android', appVersion: '0.2.0+synthetic', bootAnchorUtcMs: ANCHOR_MS, sources: declare(session) });
  event('clock_map', { mapId: mapId++, effectiveFromMonotonicUs: now, offsetUtcMinusMonotonicUs: ANCHOR_MS * 1000, mappingSource: 'wall_clock_pair', uncertaintyUs: 1500 });
  windows.clear();
  SOURCES.forEach((s, i) => {
    if (!bucketed(i, session)) return;
    event('source_accuracy_state', { sourceId: s.sourceId, previousAccuracyState: 'unobserved', accuracyState: 'high', atMeasurementMonotonicUs: null, atReceivedMonotonicUs: now, reason: 'sample_observed' });
    event('selection_anchor', { sourceId: s.sourceId, policyVersion: 'tbf-1', timeBase: 'measurement', anchorUs: now + 20000 - (now % 20000), reason });
    windows.set(s.sourceId, { index: 0, kept: 0, first: null, last: null, obs: 1 });
  });
}
function settle(sourceId) {
  const w = windows.get(sourceId);
  event('selection_stats', { sourceId, policyVersion: 'tbf-1', windowIndex: w.index, closeReason: 'periodic', firstKeptSequence: w.first, lastKeptSequence: w.last, keptCount: w.kept, receivedCount: w.kept, skippedIntentionalCount: 0, invalidCount: 0, nonmonotonicCount: 0, bufferDroppedCount: 0, pendingIn: 0, pendingOut: 0, observedAccuracyTransitions: w.obs, complete: true });
  Object.assign(w, { index: w.index + 1, kept: 0, first: null, last: null, obs: 0 });
}

// lean run: experimental, cites one accelerometer sample every 50 ms
const LEAN_RUN = 'run-synthetic';
let leanSeq = 0;
const leanEvent = (eventType, fields) =>
  lean.line({ schemaVersion: 2, recordType: 'lean_event', eventType, recordingId: REC, leanRunId: LEAN_RUN, sourceId: 'lean-estimator', deviceBootId: BOOT, occurredAtUtc: utc(now), occurredMonotonicUs: now, lastSequences: { 'lean-estimator': leanSeq - 1 }, ...fields });
leanEvent('lean_started', {
  platform: 'android', appVersion: '0.2.0+synthetic', algorithmVersion: 'lean-geometry-2', inputSources: [{ sourceId: ACC, stream: 'motion' }], inputConsumption: 'stored_only', maxInputGapUs: 100000,
  replayable: false, replayScope: { estimate: false, calibration: false, refilter: false },
  extremumPolicy: { policyVersion: 'extremum-min-abs-100ms-1', rule: 'min_abs_in_same_side_window', minWindowUs: 100000 },
  autoReferenceConfigFingerprint: null, qualification: { status: 'experimental', qualificationRef: null, qualifiedConfiguration: null, configurationFingerprint: null }, derivesFrom: null,
});
leanEvent('estimator_reset', { filterEpoch: 0, reason: 'start', initialInputs: [{ sourceId: ACC, firstSequence: 0 }], initialControlCursor: -1 });
let epoch = 0;
function estimate(t, sequence, cursor) {
  lean.line({ schemaVersion: 2, recordType: 'lean_estimate', recordingId: REC, leanRunId: LEAN_RUN, sourceId: 'lean-estimator', deviceBootId: BOOT, sequence: leanSeq++, qualityFlags: ['lean_unavailable', 'no_valid_calibration', 'algorithm_unqualified'], measurementMonotonicUs: t, computedMonotonicUs: t + 8000, leanAngleDeg: null, calibrationId: null, algorithmVersion: 'lean-geometry-2', sourceRefs: [{ sourceId: ACC, firstSequence: sequence, lastSequence: sequence }], clockMapId: mapId - 1, filterEpoch: epoch, extremumEligible: false, motionControlCursor: cursor });
}

let session = 0;
startSession(session, 'start');
let sampleIndex = 0;
let t = now + 20000 - (now % 20000);
const budget = targetBytes - (profile === 'long-duplicate' ? 4096 : 0);
let sample0 = null;
let sample1 = null;
while (motion.bytes < budget) {
  if (profile === 'session-churn' && sampleIndex > 0 && sampleIndex % 2000 === 0) {
    for (const id of windows.keys()) settle(id);
    session += 1;
    now = t;
    event('recording_resumed', { reason: 'process_restart', resumedSequences: Object.fromEntries(SOURCES.map((s) => [s.sourceId, seq.get(s.sourceId)])) });
    startSession(session, 'resume');
    epoch += 1;
    leanEvent('estimator_reset', { filterEpoch: epoch, reason: 'recovery', initialInputs: [{ sourceId: ACC, firstSequence: seq.get(ACC) }], initialControlCursor: ctl - 1 });
    t = now + 20000 - (now % 20000) + 20000;
  }
  if (profile === 'clock-churn' && sampleIndex > 0 && sampleIndex % 50 === 0) {
    now = t;
    event('clock_adjusted', { previousDeviceBootId: BOOT, previousBootAnchorUtcMs: ANCHOR_MS, bootAnchorUtcMs: ANCHOR_MS + 1, thresholdMs: 500 });
    event('clock_map', { mapId: mapId++, effectiveFromMonotonicUs: now, offsetUtcMinusMonotonicUs: ANCHOR_MS * 1000 + 1000, mappingSource: 'wall_clock_pair', uncertaintyUs: 1500 });
  }
  for (const s of SOURCES) {
    const sequence = seq.get(s.sourceId);
    const measured = t + (s === SOURCES[0] ? 0 : 1000);
    let received = measured + 1500;
    const flags = [];
    if (profile === 'many-findings' && s === SOURCES[0]) {
      flags.push('synthetic_marker');
      if (sampleIndex % 10 === 0) received = measured - 1; // measurement after its callback
    }
    const record = { schemaVersion: 2, recordType: 'motion_sample', recordingId: REC, sourceId: s.sourceId, sensorType: s.sensorType, deviceBootId: BOOT, sequence, measurementMonotonicUs: measured, receivedMonotonicUs: received, receivedAtUtc: utc(received), clockMapId: mapId - 1, accuracyLevel: 'high', qualityFlags: flags, ...s.values() };
    if (sampleIndex === 0 && s === SOURCES[0]) sample0 = record;
    if (sampleIndex === 1 && s === SOURCES[0]) sample1 = record;
    if (s === SOURCES[0]) {
      const cursor = ctl - 1;
      motion.line(record);
      if (sampleIndex % 3 === 0) estimate(measured, sequence, cursor);
    } else {
      motion.line(record);
    }
    seq.set(s.sourceId, sequence + 1);
    const w = windows.get(s.sourceId);
    if (w) {
      w.kept += 1;
      w.first ??= sequence;
      w.last = sequence;
    }
  }
  sampleIndex += 1;
  t += 20000;
  now = t;
  if (sampleIndex % 250 === 0) for (const id of windows.keys()) settle(id);
}
for (const id of windows.keys()) settle(id);

const expected = { profile, errors: [], warnings: [] };
if (profile === 'tail-corrupt') {
  motion.raw('{"schemaVersion":2,"recordType":"motion_sample","recordingId":"r-synth');
  expected.errors.push('NOT_JSON');
} else if (profile === 'long-duplicate') {
  const reordered = `{${Object.keys(sample0).reverse().map((k) => `${JSON.stringify(k)}:${JSON.stringify(sample0[k])}`).join(',')}}`;
  motion.line(reordered);
  motion.line({ ...sample1, xMps2: 7.5 });
  // Re-appending old samples also regresses time, and (C1 semantics) the index then describes the
  // latest occurrence, so the estimates that cite those sequences no longer match their cursor.
  expected.errors.push('SEQUENCE_DUPLICATE', 'SEQUENCE_CONFLICT', 'MONOTONIC_REGRESSION', 'MEASUREMENT_MONOTONIC_REGRESSION', 'CONTROL_CURSOR_MISMATCH');
} else if (profile === 'dangling-refs') {
  for (let k = 1; k <= 3; k += 1) estimate(t + k * 20000, seq.get(ACC) + k, ctl - 1);
  expected.errors.push('SOURCE_REF_UNRESOLVED');
} else if (profile === 'many-findings') {
  expected.errors.push('MEASUREMENT_AFTER_RECEIVED');
  expected.warnings.push('UNKNOWN_QUALITY_FLAG');
}
motion.close();
lean.close();
process.stdout.write(`${JSON.stringify({ ...expected, motionBytes: motion.bytes, motionLines: motion.lines, leanBytes: lean.bytes, leanLines: lean.lines })}\n`);
