// v1 regression cases (0003 A.3 V1-1..V1-5, §F). Each case is judged by the CURRENT tool
// (new.result / new.expected / new.absent). Its result under the frozen 7474933 tool is
// recorded in old-tool.json by actually running that tool, never by assumption; the test
// runner re-runs the frozen tool and fails if the recording is stale.

import { ACC, EXTREMUM_POLICY, MotionLog, T0, source } from './v2-builders.mjs';
import { validateMotionLog as legacyMotion, validateLeanLog as legacyLean } from './legacy/validate-motion-lean.7474933.mjs';

const V1 = { version: 1 };
const v1Source = (stride) => source(ACC, 'accelerometer', { override: { storageStride: stride } });
const j = (lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;

function v1Lean(replayable = false) {
  const lines = [];
  let seq = 0;
  const base = (boot) => ({ schemaVersion: 1, recordingId: 'r-v1-lean', sourceId: 'lean-estimator', deviceBootId: boot ?? 'boot-a' });
  const event = (eventType, fields, o = {}) =>
    lines.push({
      ...base(o.boot),
      recordType: 'lean_event',
      eventType,
      occurredAtUtc: new Date(1_791_000_000_000 + (o.at ?? T0) / 1000).toISOString(),
      occurredMonotonicUs: o.at ?? T0,
      lastSequence: seq - 1,
      ...fields,
    });
  const record = (recordType, fields, boot) => lines.push({ ...base(boot), recordType, sequence: seq++, ...fields });
  event('lean_started', { platform: 'android', appVersion: '0.2.0+fixture', algorithmVersion: 'lean-geometry-1', inputSourceIds: [ACC], maxInputGapUs: 100000, replayable, extremumPolicy: EXTREMUM_POLICY });
  event('estimator_reset', { filterEpoch: 0, reason: 'start', initialInputs: [{ sourceId: ACC, firstSequence: 0 }] });
  return { lines, event, record, seq: () => seq };
}

const calibration = (id, o = {}) => {
  const from = o.from ?? T0;
  const carried = o.origin === 'carried_over';
  const range = { fromMonotonicUs: from - 3000000, toMonotonicUs: from - 100000 };
  return {
    calibrationId: id,
    supersedesCalibrationId: o.supersedes ?? null,
    origin: o.origin ?? 'manual_upright',
    effectiveFromMonotonicUs: from,
    writtenMonotonicUs: from,
    upDevice: { x: 0, y: 0.8, z: 0.6 },
    leanAxisDevice: { x: 1, y: 0, z: 0 },
    leanAxisSource: carried ? 'inherited_from_previous' : 'manual_left_lean',
    leftLeanConfirmation: carried ? null : { peakLeanMagnitudeDeg: 14.2, durationUs: 2500000, sourceRange: range },
    evidence: carried ? null : { kind: 'manual_rest', restDurationUs: 3000000, upSpreadDeg: 0.08, sourceRange: range },
    carriedOverFromCalibrationId: o.carriedFrom ?? null,
    algorithmVersion: 'calibration-1',
    qualityFlags: o.flags ?? [],
  };
};
const estimate = (t, refs, o = {}) => ({
  measurementMonotonicUs: t,
  computedMonotonicUs: t + 8000,
  leanAngleDeg: o.angle ?? 2,
  calibrationId: o.cal ?? 'cal-1',
  algorithmVersion: 'lean-geometry-1',
  sourceRefs: [{ sourceId: ACC, firstSequence: refs[0], lastSequence: refs[1] }],
  clockMapId: 0,
  filterEpoch: o.epoch ?? 0,
  extremumEligible: o.eligible ?? false,
  qualityFlags: o.flags ?? [],
});

// Session A (samples 0..2, stride a) and session B (samples 3..5, stride b).
function twoSessionMotion(a, b) {
  const m = new MotionLog(V1);
  m.started([v1Source(a)]);
  m.clockMap(0);
  m.samples_(ACC, T0, 3);
  m.resumed('process_restart');
  m.started([v1Source(b)]);
  m.clockMap(1);
  m.samples_(ACC, T0 + 400000, 3, 20000, { clockMapId: 1 });
  return m;
}
function twoSessionLean(motion, { inA, inB }) {
  const l = v1Lean(true);
  l.record('lean_calibration', calibration('cal-1'));
  const t = (seq) => motion.samples.get(`${ACC}#${seq}`).t;
  if (inA) l.record('lean_estimate', estimate(t(2), [2, 2]));
  if (inB) {
    l.event('estimator_reset', { filterEpoch: 1, reason: 'recovery', initialInputs: [{ sourceId: ACC, firstSequence: 3 }] });
    l.record('lean_estimate', estimate(t(4), [4, 4], { epoch: 1 }));
  }
  return l;
}

export function addRegressionCases(out) {
  const summarize = (r) => ({ ok: r.ok, findings: r.findings.map((f) => ({ code: f.code, severity: f.severity, line: f.line })) });
  const add = (name, { motion = null, lean, result, expected = [], absent = [] }) => {
    const dir = `v1/regression/${name}`;
    const leanText = j(lean.lines);
    const motionText = motion ? motion.text() : null;
    const oldMotion = motionText ? legacyMotion(motionText) : null;
    const oldLean = legacyLean(leanText, { motion: oldMotion });
    if (motionText) out.set(`${dir}/motion.ndjson`, motionText);
    out.set(`${dir}/lean.ndjson`, leanText);
    out.set(`${dir}/new.result`, `${result}\n`);
    out.set(`${dir}/new.expected`, expected.length ? `${expected.join('\n')}\n` : '');
    if (absent.length) out.set(`${dir}/new.absent`, `${absent.join('\n')}\n`);
    out.set(`${dir}/old-tool.json`, `${JSON.stringify({ tool: '7474933', ...(oldMotion ? { motion: summarize(oldMotion) } : {}), lean: summarize(oldLean) }, null, 2)}\n`);
  };

  // V1-3: the declaration of the session a reference was written in decides, not the file's maximum stride.
  {
    const m = twoSessionMotion(2, 1);
    add('R-01-stride-2-then-1-refs-in-B', { motion: m, lean: twoSessionLean(m, { inA: false, inB: true }), result: 'PASS', absent: ['REPLAY_STRIDE_DROPS_INPUTS'] });
  }
  {
    const m = twoSessionMotion(1, 2);
    add('R-02a-stride-1-then-2-refs-in-A-and-B', { motion: m, lean: twoSessionLean(m, { inA: true, inB: true }), result: 'FAIL', expected: ['REPLAY_STRIDE_DROPS_INPUTS'] });
  }
  {
    const m = twoSessionMotion(1, 2);
    add('R-02b-stride-1-then-2-refs-only-in-B', { motion: m, lean: twoSessionLean(m, { inA: false, inB: true }), result: 'FAIL', expected: ['REPLAY_STRIDE_DROPS_INPUTS'] });
  }
  {
    const m = twoSessionMotion(1, 2);
    add('R-02c-stride-1-then-2-refs-only-in-A', { motion: m, lean: twoSessionLean(m, { inA: true, inB: false }), result: 'PASS', absent: ['REPLAY_STRIDE_DROPS_INPUTS'] });
  }
  // V1-2: a blocking flag and extremumEligible together.
  {
    const l = v1Lean();
    l.record('lean_calibration', calibration('cal-1', { flags: ['sensor_accuracy_unreliable'] }));
    l.record('lean_estimate', estimate(T0 + 20000, [0, 0], { eligible: true, flags: ['sensor_accuracy_unreliable', 'calibration_input_unverified'] }));
    add('R-03-v1-blocking-flags-with-eligible', { lean: l, result: 'FAIL', expected: ['EXTREMUM_ELIGIBLE_BLOCKED'] });
  }
  // V1-4: the calibration's taint must reach every estimate, eligible or not.
  {
    const l = v1Lean();
    l.record('lean_calibration', calibration('cal-1', { flags: ['sensor_accuracy_unreliable'] }));
    l.record('lean_estimate', estimate(T0 + 20000, [0, 0], { eligible: false, flags: [] }));
    add('R-04-v1-taint-dropped-not-eligible', { lean: l, result: 'FAIL', expected: ['ESTIMATE_CALIBRATION_TAINT_DROPPED'], absent: ['EXTREMUM_ELIGIBLE_BLOCKED'] });
  }
  // V1-5: a carried_over calibration keeps the taint of its source.
  {
    const l = v1Lean();
    l.record('lean_calibration', calibration('cal-1', { flags: ['calibration_input_unverified'] }));
    l.record('lean_estimate', estimate(T0 + 20000, [0, 0], { flags: ['calibration_input_unverified'] }));
    l.event('recording_resumed', { reason: 'boot', resumedSequence: l.seq() }, { boot: 'boot-b', at: T0 + 2000000 });
    l.event('estimator_reset', { filterEpoch: 1, reason: 'boot_changed', initialInputs: [{ sourceId: ACC, firstSequence: 0 }] }, { boot: 'boot-b', at: T0 + 2000000 });
    l.record('lean_calibration', calibration('cal-2', { origin: 'carried_over', carriedFrom: 'cal-1', supersedes: 'cal-1', from: T0 + 2000000, flags: ['carried_over_unverified'] }), 'boot-b');
    add('R-05-v1-carried-over-drops-taint', { lean: l, result: 'FAIL', expected: ['CARRIED_OVER_TAINT_DROPPED'] });
  }
  // sensor_accuracy_unknown is v2 only: in a v1 file it stays an unknown flag (a warning), and never taints.
  {
    const l = v1Lean();
    l.record('lean_calibration', calibration('cal-1', { flags: ['sensor_accuracy_unknown'] }));
    l.record('lean_estimate', estimate(T0 + 20000, [0, 0], { flags: [] }));
    add('R-06-v1-sensor-accuracy-unknown-is-not-taint', { lean: l, result: 'PASS', absent: ['ESTIMATE_CALIBRATION_TAINT_DROPPED'] });
  }
}
