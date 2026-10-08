#!/usr/bin/env node
// Generates testdata/contracts/motion-lean/v2 from the builders, or with --check
// verifies that the committed files are exactly what the builders produce.
//   node test/build-v2-fixtures.mjs          write
//   node test/build-v2-fixtures.mjs --check  fail on drift
// Layout (same conventions as v1): motion|lean/{valid,invalid}/NAME.ndjson with
// NAME.expected (error codes that must appear), NAME.absent (codes that must NOT
// appear), NAME.warnings; pairs/{valid,invalid}/CASE/{motion,lean}.ndjson with
// lean.expected; runs/{valid,invalid}/CASE/{parent,lean}.ndjson (--parent check).

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRegressionCases } from './v1-regression.mjs';
import { ACC, GYR, POLICY, QUALIFIED_CONFIG, T0, LeanLog, MotionLog, sha256, source } from './v2-builders.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../testdata/contracts/motion-lean');
const MANAGED = ['v2/', 'v1/regression/'];
const EXP = ['algorithm_unqualified'];

const out = new Map(); // relative path -> content
const put = (path, content) => out.set(`v2/${path}`, content);
const list = (codes) => `${codes.join('\n')}\n`;

function motionCase(kind, name, log, { expected, absent, warnings } = {}) {
  put(`motion/${kind}/${name}.ndjson`, typeof log === 'string' ? log : log.text());
  if (expected) put(`motion/${kind}/${name}.expected`, list(expected));
  if (absent) put(`motion/${kind}/${name}.absent`, list(absent));
  if (warnings) put(`motion/${kind}/${name}.warnings`, list(warnings));
}
function leanCase(kind, name, log, { expected, absent, warnings } = {}) {
  put(`lean/${kind}/${name}.ndjson`, typeof log === 'string' ? log : log.text());
  if (expected) put(`lean/${kind}/${name}.expected`, list(expected));
  if (absent) put(`lean/${kind}/${name}.absent`, list(absent));
  if (warnings) put(`lean/${kind}/${name}.warnings`, list(warnings));
}
function pairCase(kind, name, motion, lean, { expected } = {}) {
  put(`pairs/${kind}/${name}/motion.ndjson`, motion.text());
  put(`pairs/${kind}/${name}/lean.ndjson`, lean.text());
  if (expected) put(`pairs/${kind}/${name}/lean.expected`, list(expected));
}
function runCase(kind, name, parentText, lean, { expected } = {}) {
  put(`runs/${kind}/${name}/parent.ndjson`, parentText);
  put(`runs/${kind}/${name}/lean.ndjson`, lean.text());
  if (expected) put(`runs/${kind}/${name}/lean.expected`, list(expected));
}

// ------------------------------------------------------------ motion bases

const bucketSource = () => source(ACC, 'accelerometer', { policy: true });

// A time-bucket session with n samples, one per bucket, fully settled by a stats event.
function bucketLog(n = 3, o = {}) {
  const log = new MotionLog(o);
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC);
  log.samples_(ACC, T0, n);
  if (o.stats !== false) log.stats(ACC, { kept: n, first: 0, last: n - 1, received: n + 2, skipped: 2, obs: 1 });
  return log;
}
function fullLog(n = 3) {
  const log = new MotionLog();
  log.started([source(ACC, 'accelerometer')]);
  log.clockMap(0);
  log.samples_(ACC, T0, n);
  return log;
}

// ------------------------------------------------------------ motion valid

motionCase('valid', '01a-full-store-minimal', fullLog());
motionCase('valid', '01b-time-bucket-minimal', bucketLog());

{
  const log = new MotionLog();
  log.started([bucketSource(), source(GYR, 'gyroscope', { policy: true })]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.accuracyState(GYR, 'unobserved', 'unavailable', { atReceived: T0 });
  log.anchor(ACC);
  log.anchor(GYR);
  log.samples_(ACC, T0, 2);
  log.samples_(GYR, T0 + 5000, 2, 20000, { accuracy: null });
  log.stats(ACC, { kept: 2, first: 0, last: 1, received: 2, obs: 1 });
  log.stats(GYR, { kept: 2, first: 0, last: 1, received: 2, obs: 1 });
  motionCase('valid', '02-unobserved-then-unavailable', log);
}
{
  // high -> unreliable -> high happened entirely inside skipped callbacks.
  const log = new MotionLog();
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC);
  log.sample(ACC, T0);
  log.accuracyState(ACC, 'high', 'unreliable', { atReceived: T0 + 9000 });
  log.accuracyState(ACC, 'unreliable', 'high', { atReceived: T0 + 15000 });
  log.sample(ACC, T0 + 20000);
  log.stats(ACC, { kept: 2, first: 0, last: 1, received: 6, skipped: 4, obs: 3 });
  motionCase('valid', '03-skipped-high-unreliable-high', log);
}
{
  const log = new MotionLog();
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC);
  log.samples_(ACC, T0, 2);
  log.clockAdjusted({}); // UTC only: same boot, not a session boundary
  log.clockMap(1);
  log.samples_(ACC, T0 + 40000, 2, 20000, { clockMapId: 1 });
  log.stats(ACC, { kept: 4, first: 0, last: 3, received: 4, obs: 1 });
  motionCase('valid', '04-utc-clock-adjusted-keeps-policy', log);
}
{
  const log = new MotionLog();
  log.started([source(ACC, 'accelerometer', { policy: true, clock: 'unverified' })]);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC, { timeBase: 'received', anchorUs: T0 + 1500 });
  log.samples_(ACC, T0, 2); // measurement null while unverified
  log.clockMap(0);
  log.sourceClock(ACC, 'unverified', 'elapsed_realtime');
  log.anchor(ACC, { timeBase: 'measurement', anchorUs: T0 + 60000, reason: 'clock_epoch' });
  log.samples_(ACC, T0 + 60000, 2);
  log.stats(ACC, { kept: 4, first: 0, last: 3, received: 4, obs: 1 });
  motionCase('valid', '05-unverified-clock-received-bucket', log);
}
{
  const log = new MotionLog();
  log.started([source(ACC, 'accelerometer')]);
  log.clockMap(0);
  log.samples_(ACC, T0, 3);
  log.resumed('process_restart');
  log.started([bucketSource()]);
  log.clockMap(1);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 + 200000 });
  log.anchor(ACC, { anchorUs: T0 + 200000, reason: 'resume' });
  log.samples_(ACC, T0 + 200000, 2, 20000, { clockMapId: 1 });
  log.stats(ACC, { kept: 2, first: 3, last: 4, received: 3, skipped: 1, obs: 1 });
  motionCase('valid', '06-multi-session-full-then-bucket', log);
}
{
  const log = new MotionLog();
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC);
  log.sample(ACC, T0);
  log.stats(ACC, { windowIndex: 0, kept: 1, first: 0, last: 0, received: 3, skipped: 1, pendingOut: 1, obs: 1 });
  log.stats(ACC, { windowIndex: 1, kept: 0, received: 0, pendingIn: 1, pendingOut: 1 }); // empty window: no invented sequences
  log.sample(ACC, T0 + 40000);
  log.stats(ACC, { windowIndex: 2, kept: 1, first: 1, last: 1, received: 0, pendingIn: 1 });
  motionCase('valid', '07-stats-empty-window-and-pending-chain', log);
}
{
  const log = new MotionLog();
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC);
  log.samples_(ACC, T0, 2); // crash before the window was settled
  log.resumed('crash');
  log.stats(ACC, { windowIndex: 0, kept: 2, first: 0, last: 1, complete: false, closeReason: 'recovered_unsettled', obs: null });
  log.started([bucketSource()]);
  log.clockMap(1);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 + 300000 });
  log.anchor(ACC, { anchorUs: T0 + 300000, reason: 'resume' });
  log.sample(ACC, T0 + 300000, { clockMapId: 1 }); // the file ends before this window is settled
  motionCase('valid', '08-unsettled-window-and-recovered', log, { warnings: ['UNSETTLED_SELECTION_WINDOW'] });
}
{
  const log = new MotionLog();
  log.started([source(ACC, 'accelerometer')]);
  log.clockMap(0);
  log.samples_(ACC, T0, 2);
  log.truncated({ [ACC]: 3 }, { cs: 5 }); // two events and a sample were lost with the tail
  log.sample(ACC, T0 + 80000, { sequence: 3 });
  log.sample(ACC, T0 + 100000, { sequence: 4 });
  motionCase('valid', '09-control-gap-accounted-by-truncation', log);
}

{
  // A gap owes a new anchor; it may not reach back before the last stored sample.
  const log = new MotionLog();
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC);
  log.samples_(ACC, T0, 2);
  log.dropped(ACC, 3, 'buffer_full');
  log.anchor(ACC, { anchorUs: T0 + 100000, reason: 'gap' });
  log.samples_(ACC, T0 + 100000, 2);
  log.stats(ACC, { kept: 4, first: 0, last: 3, received: 9, skipped: 2, dropped: 3, obs: 1 });
  motionCase('valid', '10-anchor-after-gap', log);
}

// ------------------------------------------------------------ motion invalid

{
  const log = fullLog();
  log.edit(log.lines.length - 1, (r) => { r.schemaVersion = 1; });
  motionCase('invalid', '01-mixed-schema-versions', log, { expected: ['SCHEMA_VERSION_MIXED'] });
}
{
  const log = fullLog();
  motionCase('invalid', '02-unsupported-schema-version', log.text().replaceAll('"schemaVersion":2', '"schemaVersion":3'), { expected: ['UNSUPPORTED_SCHEMA_VERSION'] });
}
{
  const log = bucketLog(2, { stats: false });
  log.started([source(ACC, 'accelerometer', { policy: true, policyOverride: { periodUs: 40000 } })]);
  motionCase('invalid', '04-policy-redeclared-in-session', log, { expected: ['POLICY_REDECLARED'] });
}
for (const [name, override, codes] of [
  ['05a-no-policy-stride-2', { storageStride: 2 }, ['SCHEMA_INVALID']],
  ['05b-no-policy-stride-null', { storageStride: null }, ['STRIDE_POLICY_CONFLICT']],
]) {
  const log = new MotionLog();
  log.started([source(ACC, 'accelerometer', { override })]);
  log.clockMap(0);
  log.samples_(ACC, T0, 2);
  motionCase('invalid', name, log, { expected: codes });
}
for (const [name, override, codes] of [
  ['05c-policy-stride-1', { storageStride: 1 }, ['STRIDE_POLICY_CONFLICT']],
  ['05d-policy-stride-2', { storageStride: 2 }, ['SCHEMA_INVALID']],
  ['05e-policy-not-lossy', { inputPolicy: { ...POLICY, lossy: false } }, ['SCHEMA_INVALID']],
  ['05f-policy-unknown-kind', { inputPolicy: { ...POLICY, kind: 'every_nth' } }, ['SCHEMA_INVALID']],
]) {
  const log = new MotionLog();
  log.started([source(ACC, 'accelerometer', { policy: true, override })]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC);
  log.samples_(ACC, T0, 2);
  motionCase('invalid', name, log, { expected: codes });
}
{
  const log = new MotionLog();
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC);
  log.sample(ACC, T0);
  log.sample(ACC, T0 + 5000); // same 20 ms bucket
  log.stats(ACC, { kept: 2, first: 0, last: 1, received: 2, obs: 1 });
  motionCase('invalid', '06-two-samples-in-one-bucket', log, { expected: ['SELECTION_BUCKET_VIOLATION'] });
}
{
  const log = new MotionLog();
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC);
  log.sample(ACC, T0);
  log.sample(ACC, T0 + 20000, { accuracy: 'unreliable' }); // changed, never recorded
  log.stats(ACC, { kept: 2, first: 0, last: 1, received: 2, obs: 1 });
  motionCase('invalid', '07-accuracy-change-unrecorded', log, { expected: ['ACCURACY_CHANGE_UNRECORDED'] });
}
{
  const log = new MotionLog();
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'high', 'unreliable'); // the current state is unobserved
  log.anchor(ACC);
  motionCase('invalid', '08-accuracy-state-chain', log, { expected: ['ACCURACY_STATE_CHAIN'] });
}
{
  const kept = bucketLog(3, { stats: false });
  kept.stats(ACC, { kept: 4, first: 0, last: 2, received: 5, skipped: 2, obs: 1 });
  motionCase('invalid', '09a-stats-kept-count', kept, { expected: ['SELECTION_STATS_MISMATCH'] });
  const eq = bucketLog(3, { stats: false });
  eq.stats(ACC, { kept: 3, first: 0, last: 2, received: 9, skipped: 2, obs: 1 }); // 9 != 3 + 2
  motionCase('invalid', '09b-stats-equation', eq, { expected: ['SELECTION_STATS_MISMATCH'] });
  const idx = bucketLog(3, { stats: false });
  idx.stats(ACC, { windowIndex: 1, kept: 3, first: 0, last: 2, received: 5, skipped: 2, obs: 1 });
  motionCase('invalid', '09c-stats-window-index', idx, { expected: ['SELECTION_STATS_MISMATCH'] });
}
{
  const log = bucketLog(2, { stats: false });
  log.stats(ACC, { kept: 0, first: 0, last: 0, received: 0, obs: 1 }); // kept 0 must not name sequences
  motionCase('invalid', '10-stats-empty-window-invents-sequences', log, { expected: ['SCHEMA_INVALID'] });
}
{
  const log = fullLog();
  log.event('clock_map', { mapId: 1, effectiveFromMonotonicUs: T0, offsetUtcMinusMonotonicUs: 1, mappingSource: 'carried_forward', uncertaintyUs: 1500 }, { cs: 9 });
  motionCase('invalid', '11a-control-sequence-gap', log, { expected: ['CONTROL_SEQUENCE_GAP'] });
  const dup = fullLog();
  dup.event('clock_map', { mapId: 1, effectiveFromMonotonicUs: T0, offsetUtcMinusMonotonicUs: 1, mappingSource: 'carried_forward', uncertaintyUs: 1500 }, { cs: 0 });
  motionCase('invalid', '11b-control-sequence-regression', dup, { expected: ['CONTROL_SEQUENCE_REGRESSION'] });
}
{
  const log = new MotionLog();
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.sample(ACC, T0); // no selection_anchor
  motionCase('invalid', '12-selection-anchor-missing', log, { expected: ['SELECTION_ANCHOR_MISSING'] });
}
{
  const log = new MotionLog();
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC, { timeBase: 'received', anchorUs: T0 + 1500 }); // the clock is verified: must be measurement
  log.sample(ACC, T0);
  motionCase('invalid', '13-anchor-timebase-mismatch', log, { expected: ['ANCHOR_TIMEBASE_MISMATCH'] });
}
{
  const log = fullLog(2);
  log.anchor(ACC); // the session declares no inputPolicy
  motionCase('invalid', '14-selection-event-without-policy', log, { expected: ['SELECTION_WITHOUT_POLICY'] });
}
{
  // C1-1: a future anchor must not hide three samples in one bucket.
  const log = new MotionLog();
  log.started([bucketSource()]);
  log.clockMap(0);
  log.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  log.anchor(ACC, { anchorUs: 2_000_000_000 });
  for (const dt of [0, 1000, 2000]) log.sample(ACC, T0 + dt);
  log.stats(ACC, { kept: 3, first: 0, last: 2, received: 3, obs: 1 });
  motionCase('invalid', '16a-future-anchor-hides-bucket-violation', log, { expected: ['SELECTION_SAMPLE_BEFORE_ANCHOR'] });
  const early = new MotionLog();
  early.started([bucketSource()]);
  early.clockMap(0);
  early.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  early.anchor(ACC, { anchorUs: T0 + 1 }); // one microsecond after the first sample
  early.sample(ACC, T0);
  early.stats(ACC, { kept: 1, first: 0, last: 0, received: 1, obs: 1 });
  motionCase('invalid', '16b-sample-one-microsecond-before-anchor', early, { expected: ['SELECTION_SAMPLE_BEFORE_ANCHOR'] });
  // An anchor nothing asked for could move the bucket boundary: two samples 5 ms apart pass.
  const moved = new MotionLog();
  moved.started([bucketSource()]);
  moved.clockMap(0);
  moved.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  moved.anchor(ACC);
  moved.sample(ACC, T0);
  moved.anchor(ACC, { anchorUs: T0 + 5000, reason: 'gap' });
  moved.sample(ACC, T0 + 5000);
  moved.stats(ACC, { kept: 2, first: 0, last: 1, received: 2, obs: 1 });
  motionCase('invalid', '16c-unjustified-anchor-moves-bucket-boundary', moved, { expected: ['SELECTION_ANCHOR_UNJUSTIFIED'] });
  const reason = new MotionLog();
  reason.started([bucketSource()]);
  reason.clockMap(0);
  reason.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  reason.anchor(ACC, { reason: 'clock_epoch' }); // the session owes start|resume, not clock_epoch
  reason.sample(ACC, T0);
  motionCase('invalid', '16d-anchor-reason-does-not-match-the-cause', reason, { expected: ['SELECTION_ANCHOR_UNJUSTIFIED'] });
  const back = new MotionLog();
  back.started([bucketSource()]);
  back.clockMap(0);
  back.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  back.anchor(ACC);
  back.samples_(ACC, T0 + 100000, 2);
  back.dropped(ACC, 2, 'buffer_full');
  back.anchor(ACC, { anchorUs: T0, reason: 'gap' }); // reaches back before the stored samples
  back.sample(ACC, T0 + 400000);
  motionCase('invalid', '16e-anchor-reaches-back', back, { expected: ['SELECTION_ANCHOR_REGRESSION'] });
}
{
  // The same record with its keys in another order is a duplicate, not a conflict.
  const log = fullLog(2);
  const original = JSON.parse(log.lines[3]);
  const reordered = `{${Object.keys(original).reverse().map((k) => `${JSON.stringify(k)}:${JSON.stringify(original[k])}`).join(',')}}`;
  log.push(reordered);
  motionCase('invalid', '15a-duplicate-with-reordered-keys', log, { expected: ['SEQUENCE_DUPLICATE'], absent: ['SEQUENCE_CONFLICT'] });
  const conflict = fullLog(2);
  conflict.push(JSON.stringify({ ...original, xMps2: 5 }));
  motionCase('invalid', '15b-same-sequence-different-content', conflict, { expected: ['SEQUENCE_CONFLICT'], absent: ['SEQUENCE_DUPLICATE'] });
}

// ------------------------------------------------------------ lean valid

function experimentalBase(o = {}) {
  const log = new LeanLog(o);
  log.started(o.started ?? {});
  log.reset();
  return log;
}

{
  const log = experimentalBase();
  log.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  log.calibration('cal-1', { from: T0 + 100000 });
  log.estimate({ angle: 4.2, flags: EXP, t: T0 + 120000 });
  leanCase('valid', '01-experimental-run', log);
}
{
  const config = QUALIFIED_CONFIG();
  const log = new LeanLog();
  log.started({ qualification: log.qualified(config) });
  log.reset();
  log.calibration('cal-1', { from: T0 });
  log.estimate({ angle: -10, eligible: true, t: T0 + 20000 });
  log.estimate({ angle: -12, eligible: true, t: T0 + 40000 });
  log.extremum({ side: 'left', peak: 12, eventUs: T0 + 40000, estimateSequence: 2, windowStart: T0 + 20000, windowEnd: T0 + 140000 });
  leanCase('valid', '02-qualified-run-with-fingerprint', log);
}
{
  const log = experimentalBase();
  log.calibration('cal-1', { from: T0, flags: ['sensor_accuracy_unreliable'] });
  log.estimate({ angle: 3, flags: [...EXP, 'calibration_input_unverified'], t: T0 + 20000 });
  log.estimate({ angle: 3.5, flags: [...EXP, 'calibration_input_unverified'], t: T0 + 40000 });
  log.calibration('cal-2', { from: T0 + 60000, supersedes: 'cal-1' }); // a new, clean calibration clears the taint
  log.estimate({ angle: 2, calibration: 'cal-2', flags: EXP, t: T0 + 80000 });
  leanCase('valid', '03-taint-propagates-until-new-calibration', log);
}
{
  const log = experimentalBase();
  log.calibration('cal-1', { from: T0, flags: ['sensor_accuracy_unreliable'] });
  log.estimate({ angle: 3, flags: [...EXP, 'calibration_input_unverified'], t: T0 + 20000 });
  log.resumed('boot', { resumedSequences: { 'lean-estimator': 2 }, boot: 'boot-b' });
  log.reset([{ sourceId: ACC, firstSequence: 0 }], { reason: 'boot_changed', boot: 'boot-b' });
  log.calibration('cal-2', { from: T0 + 2000000, origin: 'carried_over', carriedFrom: 'cal-1', supersedes: 'cal-1', boot: 'boot-b', flags: ['sensor_accuracy_unreliable', 'carried_over_unverified'] });
  log.estimate({ angle: 3, calibration: 'cal-2', flags: [...EXP, 'carried_over_unverified', 'calibration_input_unverified'], t: T0 + 2020000, boot: 'boot-b' });
  leanCase('valid', '04-carried-over-keeps-taint', log);
}

{ // automatic reference: path 1 never suspended
  const log = experimentalBase();
  log.autoState('enabled', 'initial', []);
  for (let i = 0; i < 3; i += 1) log.hint({ i });
  leanCase('valid', '05a-auto-reference-never-suspended', log);
}
{ // path 2: the same hints, a manual command started and cancelled in the middle
  const log = experimentalBase();
  log.autoState('enabled', 'initial', []);
  log.hint({ i: 0 });
  log.hint({ i: 1 });
  log.autoReset('manual_command', [{ sourceId: ACC, sequence: 1 }]);
  log.autoState('suspended', 'manual_command_started', [{ sourceId: ACC, sequence: 1 }]);
  // no hints while suspended
  log.autoReset('manual_command', [{ sourceId: ACC, sequence: 4 }]);
  log.autoState('enabled', 'manual_command_cancelled', [{ sourceId: ACC, sequence: 4 }]);
  log.hint({ i: 4 });
  log.hint({ i: 5 });
  leanCase('valid', '05b-manual-command-cancelled', log);
}
{ // calibration present: disabled; a cancel must not switch it back on
  const log = experimentalBase();
  log.autoState('enabled', 'initial', []);
  log.hint({ i: 0 });
  log.calibration('cal-1', { from: T0 });
  log.autoState('disabled', 'calibration_present', [{ sourceId: ACC, sequence: 0 }]);
  log.autoReset('manual_command', [{ sourceId: ACC, sequence: 1 }]);
  log.autoState('suspended', 'manual_command_started', [{ sourceId: ACC, sequence: 1 }]);
  log.autoReset('manual_command', [{ sourceId: ACC, sequence: 2 }]);
  log.autoState('disabled', 'calibration_present', [{ sourceId: ACC, sequence: 2 }]); // cancel, but still blocked
  log.invalidated('cal-1', T0 + 500000);
  log.autoReset('epoch_reset', [{ sourceId: ACC, sequence: 3 }]);
  log.autoState('enabled', 'calibration_cleared', [{ sourceId: ACC, sequence: 3 }]);
  log.hint({ i: 3 });
  leanCase('valid', '05c-cancel-while-calibrated-stays-disabled', log);
}
{ // upright -> left: both resets are stored although the state stays suspended
  const log = experimentalBase();
  log.autoState('enabled', 'initial', []);
  log.autoReset('manual_command', []);
  log.autoState('suspended', 'manual_command_started', []);
  log.autoReset('manual_command', []);
  log.autoReset('manual_command', []);
  log.autoState('enabled', 'manual_command_cancelled', []);
  log.hint({ i: 0 });
  leanCase('valid', '05d-reset-while-suspended-is-stored', log);
}
{ // several records on one afterInputs boundary keep file order
  const log = experimentalBase();
  const at = [{ sourceId: ACC, sequence: 7 }];
  log.autoState('enabled', 'initial', at);
  log.hint({ i: 7, after: at });
  log.autoReset('manual_command', at);
  log.autoState('suspended', 'manual_command_started', at);
  log.autoReset('manual_command', at);
  log.autoState('enabled', 'manual_command_cancelled', at);
  log.hint({ i: 7, after: at });
  leanCase('valid', '05e-same-boundary-order', log);
}
{ // automatic calibration cites every hint since the last reset; calibration replay is declared and complete
  const log = new LeanLog();
  log.started({ replayScope: { estimate: false, calibration: true, refilter: false } });
  log.reset();
  log.autoState('enabled', 'initial', []);
  for (let i = 0; i < 3; i += 1) log.hint({ i });
  log.calibration('cal-auto', { from: T0 + 40000, origin: 'auto_straight_ride', hintRange: { firstHintSequence: 0, lastHintSequence: 2 } });
  log.autoState('disabled', 'calibration_present', [{ sourceId: ACC, sequence: 2 }]);
  leanCase('valid', '05f-auto-calibration-cites-hints', log);
}
{
  const log = new LeanLog();
  log.started({ replayScope: { estimate: false, calibration: true, refilter: false } });
  log.reset();
  log.autoState('enabled', 'initial', []);
  log.hint({ i: 0 });
  log.resumed('process_restart', { resumedSequences: { 'lean-estimator': 0, 'lean-hint': 1 } });
  log.reset([{ sourceId: ACC, firstSequence: 0 }], { reason: 'recovery' });
  log.autoState('enabled', 'recovery', [{ sourceId: ACC, sequence: 0 }]); // the initial state is stored again after a resume
  log.hint({ i: 1 });
  leanCase('valid', '05g-initial-state-stored-again-after-resume', log);
}

{ // the estimator becomes unavailable while the automatic reference is enabled, then recovers
  const log = new LeanLog();
  log.started({ replayScope: { estimate: false, calibration: true, refilter: false } });
  log.reset();
  log.autoState('enabled', 'initial', []);
  log.hint({ i: 0 });
  log.estimatorState('unavailable', 'input_interrupted');
  log.autoReset('epoch_reset', [{ sourceId: ACC, sequence: 0 }]);
  log.autoState('disabled', 'estimator_unavailable', [{ sourceId: ACC, sequence: 0 }]);
  log.estimatorState('available');
  log.reset([{ sourceId: ACC, firstSequence: 3 }], { reason: 'input_clock_state_change' });
  log.autoState('enabled', 'estimator_available', [{ sourceId: ACC, sequence: 2 }]);
  log.hint({ i: 3 });
  leanCase('valid', '05h-estimator-unavailable-then-recovered', log);
}
{ // unavailable while already suspended: nothing is owed, the manual command's state stands
  const log = new LeanLog();
  log.started({ replayScope: { estimate: false, calibration: true, refilter: false } });
  log.reset();
  log.autoState('enabled', 'initial', []);
  log.autoReset('manual_command', []);
  log.autoState('suspended', 'manual_command_started', []);
  log.estimatorState('unavailable', 'input_interrupted');
  log.estimatorState('available');
  log.reset([{ sourceId: ACC, firstSequence: 1 }], { reason: 'input_clock_state_change' });
  log.autoReset('manual_command', []);
  log.autoState('enabled', 'manual_command_cancelled', []);
  log.hint({ i: 1 });
  leanCase('valid', '05i-unavailable-while-suspended', log);
}

// ------------------------------------------------------------ lean invalid

{
  const log = experimentalBase();
  log.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  log.edit(log.lines.length - 1, (r) => { r.leanRunId = 'run-other'; });
  leanCase('invalid', '01-run-id-mismatch', log, { expected: ['RUN_ID_MISMATCH'] });
}
{
  const log = experimentalBase();
  log.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  log.edit(log.lines.length - 1, (r) => { r.schemaVersion = 1; });
  leanCase('invalid', '02-mixed-schema-versions', log, { expected: ['SCHEMA_VERSION_MIXED'] });
  leanCase('invalid', '03-unsupported-schema-version', experimentalBase().text().replaceAll('"schemaVersion":2', '"schemaVersion":3'), { expected: ['UNSUPPORTED_SCHEMA_VERSION'] });
}
{
  // I-22a: eligible estimate on a tainted calibration, flag not passed on
  const config = QUALIFIED_CONFIG();
  const log = new LeanLog();
  log.started({ qualification: log.qualified(config) });
  log.reset();
  log.calibration('cal-1', { from: T0, flags: ['sensor_accuracy_unreliable'] });
  log.estimate({ angle: -10, eligible: true, t: T0 + 20000 });
  leanCase('invalid', '04a-taint-dropped-while-eligible', log, { expected: ['ESTIMATE_CALIBRATION_TAINT_DROPPED'] });
  // I-22b: not eligible, but the flag is still lost
  const quiet = experimentalBase();
  quiet.calibration('cal-1', { from: T0, flags: ['calibration_input_unverified'] });
  quiet.estimate({ angle: 3, flags: EXP, t: T0 + 20000 });
  leanCase('invalid', '04b-taint-dropped-not-eligible', quiet, { expected: ['ESTIMATE_CALIBRATION_TAINT_DROPPED'], absent: ['EXTREMUM_ELIGIBLE_BLOCKED'] });
  // sensor_accuracy_unknown taints in v2 as well
  const unknown = experimentalBase();
  unknown.calibration('cal-1', { from: T0, flags: ['sensor_accuracy_unknown'] });
  unknown.estimate({ angle: 3, flags: EXP, t: T0 + 20000 });
  leanCase('invalid', '04c-unknown-accuracy-taints-in-v2', unknown, { expected: ['ESTIMATE_CALIBRATION_TAINT_DROPPED'] });
}
{
  const log = experimentalBase();
  log.calibration('cal-1', { from: T0, flags: ['sensor_accuracy_unreliable'] });
  log.estimate({ angle: 3, flags: [...EXP, 'calibration_input_unverified'], t: T0 + 20000 });
  log.resumed('boot', { resumedSequences: { 'lean-estimator': 2 }, boot: 'boot-b' });
  log.reset([{ sourceId: ACC, firstSequence: 0 }], { reason: 'boot_changed', boot: 'boot-b' });
  log.calibration('cal-2', { from: T0 + 2000000, origin: 'carried_over', carriedFrom: 'cal-1', supersedes: 'cal-1', boot: 'boot-b', flags: ['carried_over_unverified'] });
  leanCase('invalid', '05-carried-over-drops-taint', log, { expected: ['CARRIED_OVER_TAINT_DROPPED'] });
}
{
  const log = experimentalBase();
  log.calibration('cal-1', { from: T0 });
  log.estimate({ angle: -10, eligible: true, flags: EXP, t: T0 + 20000 });
  leanCase('invalid', '06a-experimental-eligible-estimate', log, { expected: ['EXTREMUM_IN_EXPERIMENTAL_RUN', 'EXTREMUM_ELIGIBLE_BLOCKED'] });
  const unflagged = experimentalBase();
  unflagged.calibration('cal-1', { from: T0 });
  unflagged.estimate({ angle: 3, t: T0 + 20000 });
  leanCase('invalid', '06b-experimental-estimate-unflagged', unflagged, { expected: ['EXPERIMENTAL_ESTIMATE_UNFLAGGED'] });
  const extremum = experimentalBase();
  extremum.calibration('cal-1', { from: T0 });
  extremum.estimate({ angle: -10, flags: EXP, t: T0 + 20000 });
  extremum.extremum({ side: 'left', peak: 10, eventUs: T0 + 20000, estimateSequence: 1, windowStart: T0, windowEnd: T0 + 120000 });
  leanCase('invalid', '06c-experimental-run-writes-extremum', extremum, { expected: ['EXTREMUM_IN_EXPERIMENTAL_RUN', 'EXTREMUM_ESTIMATE_INELIGIBLE'] });
}
{
  const config = QUALIFIED_CONFIG();
  const noRef = new LeanLog();
  noRef.started({ qualification: noRef.qualified(config, { ref: null }) });
  noRef.reset();
  noRef.estimate({ angle: null, calibration: null, t: T0 });
  leanCase('invalid', '07a-qualified-without-ref', noRef, { expected: ['QUALIFIED_WITHOUT_REF'] });
  const bad = new LeanLog();
  bad.started({ qualification: bad.qualified(config, { fingerprint: sha256('not the configuration') }) });
  bad.reset();
  bad.estimate({ angle: null, calibration: null, t: T0 });
  leanCase('invalid', '07b-fingerprint-mismatch', bad, { expected: ['QUALIFICATION_FINGERPRINT_MISMATCH'] });
  const drift = new LeanLog();
  const other = { ...config, algorithmVersion: 'lean-geometry-9' };
  drift.started({ qualification: drift.qualified(other) }); // fingerprint matches `other`, lean_started declares lean-geometry-2
  drift.reset();
  drift.estimate({ angle: null, calibration: null, t: T0 });
  leanCase('invalid', '07c-qualified-config-differs-from-declaration', drift, { expected: ['QUALIFIED_CONFIG_MISMATCH'], absent: ['QUALIFICATION_FINGERPRINT_MISMATCH'] });
}
{
  const log = new LeanLog();
  log.started({ replayable: true, replayScope: { estimate: false, calibration: false, refilter: false } });
  log.reset();
  log.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  leanCase('invalid', '08a-replayable-differs-from-scope', log, { expected: ['REPLAY_SCOPE_MISMATCH'] });
  const refilter = new LeanLog();
  refilter.started({ replayScope: { estimate: false, calibration: false, refilter: true } });
  refilter.reset();
  refilter.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  leanCase('invalid', '08b-refilter-without-filter-spec', refilter, { expected: ['REFILTER_SPEC_UNRESOLVABLE'] });
}
{
  const log = experimentalBase();
  log.hint({ i: 0 }); // no auto_reference_state yet
  leanCase('invalid', '09a-hint-before-initial-state', log, { expected: ['AUTO_STATE_MISSING'] });
  const suspended = experimentalBase();
  suspended.autoState('enabled', 'initial', []);
  suspended.autoReset('manual_command', []);
  suspended.autoState('suspended', 'manual_command_started', []);
  suspended.hint({ i: 0 });
  leanCase('invalid', '09b-hint-while-suspended', suspended, { expected: ['HINT_WHILE_NOT_ENABLED'] });
  const calibrated = experimentalBase();
  calibrated.autoState('enabled', 'initial', []);
  calibrated.calibration('cal-1', { from: T0 });
  calibrated.hint({ i: 0 }); // still enabled although a calibration is in force
  leanCase('invalid', '09c-hint-while-calibrated', calibrated, { expected: ['HINT_WHILE_CALIBRATED'] });
  const resume = experimentalBase();
  resume.autoState('enabled', 'initial', []);
  resume.autoReset('manual_command', []);
  resume.autoState('suspended', 'manual_command_started', []);
  resume.autoState('enabled', 'manual_command_cancelled', []); // no reset on the way back
  leanCase('invalid', '09d-resume-without-reset', resume, { expected: ['AUTO_RESUME_WITHOUT_RESET'] });
  const enter = experimentalBase();
  enter.autoState('enabled', 'initial', []);
  enter.autoState('suspended', 'manual_command_started', []); // no reset first
  leanCase('invalid', '09e-suspend-without-reset', enter, { expected: ['AUTO_RESET_MISSING'] });
  const blocked = experimentalBase();
  blocked.autoState('enabled', 'initial', []);
  blocked.calibration('cal-1', { from: T0 });
  blocked.autoState('disabled', 'calibration_present', []);
  blocked.autoReset('manual_command', []);
  blocked.autoState('suspended', 'manual_command_started', []);
  blocked.autoReset('manual_command', []);
  blocked.autoState('enabled', 'manual_command_cancelled', []); // the calibration still blocks
  leanCase('invalid', '09f-cancel-enables-while-blocked', blocked, { expected: ['AUTO_ENABLED_WHILE_BLOCKED'] });
  const regress = experimentalBase();
  regress.autoState('enabled', 'initial', []);
  regress.hint({ i: 5 });
  regress.hint({ i: 4, after: [{ sourceId: ACC, sequence: 4 }] });
  leanCase('invalid', '09g-after-inputs-regress', regress, { expected: ['HINT_CURSOR_REGRESSION'] });
}
{
  const log = new LeanLog();
  log.started({ replayScope: { estimate: false, calibration: true, refilter: false } });
  log.reset();
  log.hint({ i: 0 }); // calibration replay declared, but no state history
  leanCase('invalid', '10a-calibration-replay-without-state', log, { expected: ['CALIBRATION_REPLAY_STATE_INCOMPLETE', 'AUTO_STATE_MISSING'] });
  const none = new LeanLog();
  none.started({ replayScope: { estimate: false, calibration: true, refilter: false } });
  none.reset();
  none.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  leanCase('invalid', '10b-calibration-replay-with-no-state-at-all', none, { expected: ['CALIBRATION_REPLAY_STATE_INCOMPLETE'] });
  const resumed = new LeanLog();
  resumed.started({ replayScope: { estimate: false, calibration: true, refilter: false } });
  resumed.reset();
  resumed.autoState('enabled', 'initial', []);
  resumed.resumed('process_restart', { resumedSequences: { 'lean-estimator': 0 } });
  resumed.reset([{ sourceId: ACC, firstSequence: 0 }], { reason: 'recovery' });
  resumed.estimate({ angle: null, calibration: null, flags: EXP, t: T0 }); // no state stored again after the resume
  leanCase('invalid', '10c-no-initial-state-after-resume', resumed, { expected: ['CALIBRATION_REPLAY_STATE_INCOMPLETE'] });
}
{
  const gap = new LeanLog();
  gap.started({ replayScope: { estimate: false, calibration: true, refilter: false } });
  gap.reset();
  gap.autoState('enabled', 'initial', []);
  for (let i = 0; i < 3; i += 1) gap.hint({ i });
  gap.calibration('cal-auto', { from: T0 + 40000, origin: 'auto_straight_ride', hintRange: { firstHintSequence: 1, lastHintSequence: 2 } });
  leanCase('invalid', '11a-hint-range-misses-first-hint', gap, { expected: ['HINT_RANGE_INCOMPLETE'] });
  const late = new LeanLog();
  late.started({});
  late.reset();
  late.autoState('enabled', 'initial', []);
  late.hint({ i: 0 });
  late.calibration('cal-auto', { from: T0 + 40000, origin: 'auto_straight_ride', hintRange: { firstHintSequence: 0, lastHintSequence: 4 } });
  leanCase('invalid', '11b-hint-range-names-a-later-hint', late, { expected: ['HINT_AFTER_CALIBRATION', 'HINT_RANGE_INCOMPLETE'] });
}
{ // C1-2: an old `enabled` must not make a hint acceptable once the file says the estimator is unavailable
  const log = new LeanLog();
  log.started({ replayScope: { estimate: false, calibration: true, refilter: false } });
  log.reset();
  log.autoState('enabled', 'initial', []);
  log.estimatorState('unavailable', 'input_interrupted');
  log.hint({ i: 0 });
  leanCase('invalid', '13a-hint-after-unavailable-without-transition', log, { expected: ['HINT_WHILE_ESTIMATOR_UNAVAILABLE', 'AUTO_STATE_TRANSITION_MISSING', 'CALIBRATION_REPLAY_STATE_INCOMPLETE'] });
  const stored = new LeanLog();
  stored.started({});
  stored.reset();
  stored.autoState('enabled', 'initial', []);
  stored.estimatorState('unavailable', 'input_interrupted');
  stored.autoReset('epoch_reset', []);
  stored.autoState('disabled', 'estimator_unavailable', []);
  stored.hint({ i: 0 }); // transition stored, but the state is disabled
  leanCase('invalid', '13b-hint-while-disabled-after-unavailable', stored, { expected: ['HINT_WHILE_ESTIMATOR_UNAVAILABLE', 'HINT_WHILE_NOT_ENABLED'] });
  const recovered = new LeanLog();
  recovered.started({});
  recovered.reset();
  recovered.autoState('enabled', 'initial', []);
  recovered.estimatorState('unavailable', 'input_interrupted');
  recovered.estimatorState('available');
  recovered.reset([{ sourceId: ACC, firstSequence: 1 }], { reason: 'input_clock_state_change' });
  recovered.hint({ i: 1 }); // available again, but the owed disabled/enabled transitions were never stored
  leanCase('invalid', '13c-recovery-without-stored-transitions', recovered, { expected: ['AUTO_STATE_TRANSITION_MISSING'], absent: ['HINT_WHILE_ESTIMATOR_UNAVAILABLE'] });
  const noReset = new LeanLog();
  noReset.started({});
  noReset.reset();
  noReset.autoState('enabled', 'initial', []);
  noReset.estimatorState('unavailable', 'input_interrupted');
  noReset.autoState('disabled', 'estimator_unavailable', []); // the interruption resets the fusion state first
  leanCase('invalid', '13d-unavailable-disabled-without-reset', noReset, { expected: ['AUTO_RESET_MISSING'] });
  const enabledWhile = new LeanLog();
  enabledWhile.started({});
  enabledWhile.reset();
  enabledWhile.autoState('enabled', 'initial', []);
  enabledWhile.estimatorState('unavailable', 'input_interrupted');
  enabledWhile.autoReset('epoch_reset', []);
  enabledWhile.autoState('enabled', 'estimator_available', []); // still unavailable
  leanCase('invalid', '13e-enabled-while-estimator-unavailable', enabledWhile, { expected: ['AUTO_ENABLED_WHILE_BLOCKED', 'AUTO_STATE_TRANSITION_MISSING'] });
  const eof = new LeanLog();
  eof.started({ replayScope: { estimate: false, calibration: true, refilter: false } });
  eof.reset();
  eof.autoState('enabled', 'initial', []);
  eof.estimatorState('unavailable', 'input_interrupted'); // the file ends: the owed transition is missing
  leanCase('invalid', '13f-calibration-replay-with-owed-transition-at-end', eof, { expected: ['CALIBRATION_REPLAY_STATE_INCOMPLETE'] });
}
{ // C1-3: the qualified configuration is bound to the declared inputs
  const config = QUALIFIED_CONFIG([{ sourceId: 'undeclared-sensor', sensorType: 'accelerometer', inputPolicy: POLICY, storageStride: null }]);
  const log = new LeanLog();
  log.started({ qualification: log.qualified(config) }); // fingerprint matches; inputSources still names the accelerometer
  log.reset();
  log.estimate({ angle: null, calibration: null, t: T0 });
  leanCase('invalid', '07d-configuration-names-an-undeclared-source', log, { expected: ['QUALIFIED_CONFIG_MISMATCH'], absent: ['QUALIFICATION_FINGERPRINT_MISMATCH'] });
  const accIn = { sourceId: ACC, sensorType: 'accelerometer', inputPolicy: POLICY, storageStride: null };
  const gyrIn = { sourceId: GYR, sensorType: 'gyroscope', inputPolicy: POLICY, storageStride: null };
  const extra = new LeanLog();
  extra.started({ qualification: extra.qualified(QUALIFIED_CONFIG([accIn, gyrIn])) }); // inputSources: accelerometer only
  extra.reset();
  extra.estimate({ angle: null, calibration: null, t: T0 });
  leanCase('invalid', '07e-configuration-has-an-extra-source', extra, { expected: ['QUALIFIED_CONFIG_MISMATCH'] });
  const missing = new LeanLog();
  missing.started({ inputSources: [{ sourceId: ACC, stream: 'motion' }, { sourceId: GYR, stream: 'motion' }], qualification: missing.qualified(QUALIFIED_CONFIG([accIn])) });
  missing.reset();
  missing.estimate({ angle: null, calibration: null, t: T0 });
  leanCase('invalid', '07f-configuration-misses-a-source', missing, { expected: ['QUALIFIED_CONFIG_MISMATCH'] });
  const dup = new LeanLog();
  dup.started({ qualification: dup.qualified(QUALIFIED_CONFIG([accIn, accIn])) });
  dup.reset();
  dup.estimate({ angle: null, calibration: null, t: T0 });
  leanCase('invalid', '07g-configuration-repeats-a-source', dup, { expected: ['QUALIFIED_CONFIG_MISMATCH'] });
  const dupSrc = new LeanLog();
  dupSrc.started({ inputSources: [{ sourceId: ACC, stream: 'motion' }, { sourceId: ACC, stream: 'motion' }] });
  dupSrc.reset();
  dupSrc.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  leanCase('invalid', '07h-input-sources-repeat-a-source', dupSrc, { expected: ['INPUT_SOURCES_INVALID'] });
}
{
  const log = experimentalBase();
  log.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  log.edit(log.lines.length - 1, () => {});
  log.event('estimator_state', { state: 'available', reason: null }, { lastSequences: { 'lean-estimator': 50 } });
  leanCase('invalid', '12-event-last-sequence-ahead', log, { expected: ['EVENT_SEQUENCE_AHEAD'] });
}

// ------------------------------------------------------------ owed-transition state table (C1-2)
// An estimator interruption while the automatic reference is enabled owes reset + disabled(estimator_unavailable).
// Only that pair settles it. "The estimator is available again" is not "the control history is complete".
// Steps: Ei/Ea/Er enabled(initial|estimator_available|recovery); Ec enabled(manual_command_cancelled);
//   U estimator unavailable; A estimator available + new epoch; R auto_reference_reset;
//   D disabled(estimator_unavailable); Dx disabled(calibration_present) (a wrong reason);
//   S suspended(manual_command_started); H hint; RES recording_resumed + recovery epoch; LS a new lean_started.
const OWED_TABLE = [
  // name, calibration replay claimed, steps, outcome, expected (errors | warnings), absent
  ['01-normal-interruption-and-recovery', true, 'Ei H U R D A Ea H', 'valid'],
  ['02-recovery-enabled-without-reset-or-disabled', true, 'Ei U A Ea H', 'invalid', ['AUTO_STATE_TRANSITION_MISSING', 'CALIBRATION_REPLAY_STATE_INCOMPLETE']],
  ['03-reset-only-then-recovery', true, 'Ei U R A Ea H', 'invalid', ['AUTO_STATE_TRANSITION_MISSING', 'CALIBRATION_REPLAY_STATE_INCOMPLETE']],
  ['04-enabled-while-still-unavailable', false, 'Ei U R Ea', 'invalid', ['AUTO_ENABLED_WHILE_BLOCKED', 'AUTO_STATE_TRANSITION_MISSING']],
  ['05-disabled-with-wrong-reason', true, 'Ei U R Dx A R Ea H', 'invalid', ['AUTO_STATE_TRANSITION_MISSING', 'CALIBRATION_REPLAY_STATE_INCOMPLETE']],
  ['06-suspended-instead-of-disabled', false, 'Ei U R S', 'invalid', ['AUTO_STATE_TRANSITION_MISSING']],
  ['07-wrong-then-correct-stays-violated', true, 'Ei U R Dx R D A Ea H', 'invalid', ['AUTO_STATE_TRANSITION_MISSING', 'CALIBRATION_REPLAY_STATE_INCOMPLETE']],
  ['08-disabled-without-reset', false, 'Ei U D A Ea H', 'invalid', ['AUTO_RESET_MISSING'], ['AUTO_STATE_TRANSITION_MISSING']],
  ['09-second-interruption-not-stored', false, 'Ei U R D A Ea H U A Ea H', 'invalid', ['AUTO_STATE_TRANSITION_MISSING']],
  ['10-resume-before-transition-no-replay-claim', false, 'Ei U RES A Er H', 'valid', ['AUTO_STATE_TRANSITION_UNSETTLED']],
  ['11-resume-before-transition-replay-claimed', true, 'Ei U RES A Er H', 'invalid', ['CALIBRATION_REPLAY_STATE_INCOMPLETE'], ['AUTO_STATE_TRANSITION_MISSING']],
  ['12-new-lean-started-no-replay-claim', false, 'Ei U LS A Ei H', 'valid', ['AUTO_STATE_TRANSITION_UNSETTLED']],
  ['13-new-lean-started-replay-claimed', true, 'Ei U LS A Ei H', 'invalid', ['CALIBRATION_REPLAY_STATE_INCOMPLETE']],
  ['14-end-of-file-no-replay-claim', false, 'Ei H U', 'valid', ['AUTO_STATE_TRANSITION_UNSETTLED']],
  ['15-end-of-file-replay-claimed', true, 'Ei H U', 'invalid', ['CALIBRATION_REPLAY_STATE_INCOMPLETE']],
  ['16-unavailable-while-suspended-owes-nothing', true, 'Ei R S U A R Ec H', 'valid'],
];
for (const [name, claimed, steps, outcome, codes = [], absent = []] of OWED_TABLE) {
  const scope = { estimate: false, calibration: claimed, refilter: false };
  const log = new LeanLog();
  log.started({ replayScope: scope });
  log.reset();
  let hint = 0;
  for (const step of steps.split(' ')) {
    const at = [{ sourceId: ACC, sequence: hint }];
    switch (step) {
      case 'Ei': log.autoState('enabled', 'initial', at); break;
      case 'Ea': log.autoState('enabled', 'estimator_available', at); break;
      case 'Er': log.autoState('enabled', 'recovery', at); break;
      case 'Ec': log.autoState('enabled', 'manual_command_cancelled', at); break;
      case 'U': log.estimatorState('unavailable', 'input_interrupted'); break;
      case 'A': log.estimatorState('available'); log.reset([{ sourceId: ACC, firstSequence: hint }], { reason: 'input_clock_state_change' }); break;
      case 'R': log.autoReset('epoch_reset', at); break;
      case 'D': log.autoState('disabled', 'estimator_unavailable', at); break;
      case 'Dx': log.autoState('disabled', 'calibration_present', at); break;
      case 'S': log.autoState('suspended', 'manual_command_started', at); break;
      case 'H': log.hint({ i: hint }); hint += 1; break;
      case 'RES': log.resumed('process_restart', { resumedSequences: { 'lean-estimator': 0, 'lean-hint': hint } }); log.reset([{ sourceId: ACC, firstSequence: hint }], { reason: 'recovery' }); break;
      case 'LS': log.started({ replayScope: scope }); break;
      default: throw new Error(`unknown step ${step}`);
    }
  }
  if (!log.lines.some((l) => !l.includes('"lean_event"'))) log.calibration('cal-anchor', { from: T0 + 9_000_000 }); // keep a data record
  const label = `14-owed-${name}`;
  if (outcome === 'valid') leanCase('valid', label, log, codes.length ? { warnings: codes } : {});
  else leanCase('invalid', label, log, { expected: codes, ...(absent.length ? { absent } : {}) });
}

// ------------------------------------------------------------ pairs

// A bucket-policy motion session of `n` accelerometer samples, plus a lean run that
// consumes them. Each estimate cites one sample and the control events before it.
function pairBase({ n = 4, extra, replayable = false } = {}) {
  const motion = new MotionLog();
  motion.started([bucketSource()]);
  motion.clockMap(0);
  motion.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 });
  motion.anchor(ACC);
  motion.sample(ACC, T0);
  motion.sample(ACC, T0 + 20000);
  motion.accuracyState(ACC, 'high', 'medium', { atReceived: T0 + 30000 }); // an event between samples 1 and 2
  motion.sample(ACC, T0 + 40000, { accuracy: 'medium' });
  motion.sample(ACC, T0 + 60000, { accuracy: 'medium' });
  motion.stats(ACC, { kept: 4, first: 0, last: 3, received: 6, skipped: 2, obs: 2 });
  if (extra) extra(motion);
  const lean = new LeanLog();
  lean.started({ replayable });
  lean.reset([{ sourceId: ACC, firstSequence: 0 }], { cursor: -1 });
  lean.calibration('cal-1', { from: T0 });
  return { motion, lean };
}
const cursorOf = (motion, seq) => motion.samples.get(`${ACC}#${seq}`).controlSeqBefore;
const tOf = (motion, seq) => motion.samples.get(`${ACC}#${seq}`).t;
function estimateOf(lean, motion, seq, o = {}) {
  lean.estimate({ angle: 1 + seq, flags: EXP, t: tOf(motion, seq), refs: [{ sourceId: ACC, firstSequence: seq, lastSequence: seq }], cursor: cursorOf(motion, seq), ...o });
}

{
  const { motion, lean } = pairBase();
  for (let seq = 0; seq < 4; seq += 1) estimateOf(lean, motion, seq);
  pairCase('valid', '01-cursor-follows-events', motion, lean);
}
{
  const { motion, lean } = pairBase({ replayable: true });
  for (let seq = 0; seq < 4; seq += 1) estimateOf(lean, motion, seq);
  pairCase('valid', '02-replayable-on-time-bucket-inputs', motion, lean);
}
{
  const motion = new MotionLog();
  motion.started([source(ACC, 'accelerometer')]);
  motion.clockMap(0);
  motion.samples_(ACC, T0, 3);
  motion.resumed('process_restart');
  motion.started([bucketSource()]);
  motion.clockMap(1);
  motion.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 + 400000 });
  motion.anchor(ACC, { anchorUs: T0 + 400000, reason: 'resume' });
  motion.samples_(ACC, T0 + 400000, 3, 20000, { clockMapId: 1 });
  motion.stats(ACC, { kept: 3, first: 3, last: 5, received: 3, obs: 1 });
  const lean = new LeanLog();
  lean.started({ replayable: true });
  lean.reset([{ sourceId: ACC, firstSequence: 0 }], { cursor: -1 });
  lean.calibration('cal-1', { from: T0 });
  estimateOf(lean, motion, 2);
  lean.reset([{ sourceId: ACC, firstSequence: 3 }], { reason: 'recovery', cursor: cursorOf(motion, 3) });
  estimateOf(lean, motion, 4, { epoch: 1 });
  estimateOf(lean, motion, 5, { epoch: 1 });
  pairCase('valid', '03-multi-session-each-judged-by-its-own-session', motion, lean);
}
{
  const config = QUALIFIED_CONFIG();
  const { motion } = pairBase();
  const lean = new LeanLog();
  lean.started({ qualification: lean.qualified(config) });
  lean.reset([{ sourceId: ACC, firstSequence: 0 }], { cursor: -1 });
  lean.calibration('cal-1', { from: T0 });
  estimateOf(lean, motion, 0, { flags: [], eligible: true });
  pairCase('valid', '04-qualified-config-matches-declarations', motion, lean);
}

{
  const { motion, lean } = pairBase();
  for (let seq = 0; seq < 4; seq += 1) estimateOf(lean, motion, seq);
  lean.edit(lean.lines.length - 1, (r) => { r.motionControlCursor += 1; }); // claims one event more than preceded the sample
  pairCase('invalid', '01-cursor-mismatch', motion, lean, { expected: ['CONTROL_CURSOR_MISMATCH'] });
}
{
  const { motion, lean } = pairBase();
  estimateOf(lean, motion, 0, { cursor: 99 });
  pairCase('invalid', '02-cursor-ahead', motion, lean, { expected: ['CONTROL_CURSOR_AHEAD'] });
}
{
  const motion = new MotionLog();
  motion.started([source(ACC, 'accelerometer')]);
  motion.clockMap(0);
  motion.samples_(ACC, T0, 3);
  motion.resumed('process_restart');
  motion.started([bucketSource()]);
  motion.clockMap(1);
  motion.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 + 400000 });
  motion.anchor(ACC, { anchorUs: T0 + 400000, reason: 'resume' });
  motion.samples_(ACC, T0 + 400000, 2, 20000, { clockMapId: 1 });
  motion.stats(ACC, { kept: 2, first: 3, last: 4, received: 2, obs: 1 });
  const lean = new LeanLog();
  lean.started({});
  lean.reset([{ sourceId: ACC, firstSequence: 0 }], { cursor: -1 });
  lean.calibration('cal-1', { from: T0 });
  lean.estimate({ angle: 1, flags: EXP, t: tOf(motion, 4), refs: [{ sourceId: ACC, firstSequence: 2, lastSequence: 4 }], cursor: cursorOf(motion, 4) });
  pairCase('invalid', '03-reference-spans-sessions', motion, lean, { expected: ['SOURCE_REF_SPANS_SESSIONS'] });
}
{
  const { motion } = pairBase();
  const lean = new LeanLog();
  lean.started({});
  lean.reset();
  lean.autoState('enabled', 'initial', []);
  lean.hint({ i: 0, after: [{ sourceId: ACC, sequence: 99 }] }); // the motion log ends at sequence 3
  pairCase('invalid', '04-hint-cursor-ahead-of-motion', motion, lean, { expected: ['HINT_CURSOR_AHEAD'] });
}
{
  const { motion } = pairBase();
  const config = QUALIFIED_CONFIG([{ sourceId: ACC, sensorType: 'accelerometer', inputPolicy: { ...POLICY, periodUs: 40000 }, storageStride: null }]);
  const lean = new LeanLog();
  lean.started({ qualification: lean.qualified(config) });
  lean.reset([{ sourceId: ACC, firstSequence: 0 }], { cursor: -1 });
  lean.calibration('cal-1', { from: T0 });
  estimateOf(lean, motion, 0, { flags: [], eligible: true });
  pairCase('invalid', '05-qualified-for-another-period', motion, lean, { expected: ['QUALIFIED_CONFIG_MISMATCH'] });
}
{
  // The configuration and inputSources agree, but the motion log never declares that source.
  const { motion } = pairBase();
  const ghost = { sourceId: 'undeclared-sensor', sensorType: 'accelerometer', inputPolicy: POLICY, storageStride: null };
  const lean = new LeanLog();
  lean.started({ inputSources: [{ sourceId: 'undeclared-sensor', stream: 'motion' }], qualification: lean.qualified(QUALIFIED_CONFIG([ghost])) });
  lean.reset([{ sourceId: 'undeclared-sensor', firstSequence: 0 }], { cursor: -1 });
  lean.calibration('cal-1', { from: T0 });
  pairCase('invalid', '06-qualified-source-absent-from-motion', motion, lean, { expected: ['QUALIFIED_CONFIG_MISMATCH'] });
}
{
  // A qualified claim covers the whole file: session A stores everything, the configuration says time buckets.
  const motion = new MotionLog();
  motion.started([source(ACC, 'accelerometer')]);
  motion.clockMap(0);
  motion.samples_(ACC, T0, 3);
  motion.resumed('process_restart');
  motion.started([bucketSource()]);
  motion.clockMap(1);
  motion.accuracyState(ACC, 'unobserved', 'high', { atReceived: T0 + 400000 });
  motion.anchor(ACC, { anchorUs: T0 + 400000, reason: 'resume' });
  motion.samples_(ACC, T0 + 400000, 2, 20000, { clockMapId: 1 });
  motion.stats(ACC, { kept: 2, first: 3, last: 4, received: 2, obs: 1 });
  const lean = new LeanLog();
  lean.started({ qualification: lean.qualified(QUALIFIED_CONFIG()) });
  lean.reset([{ sourceId: ACC, firstSequence: 3 }], { cursor: -1 });
  lean.calibration('cal-1', { from: T0 + 400000 });
  pairCase('invalid', '07-qualified-but-one-session-declares-otherwise', motion, lean, { expected: ['QUALIFIED_CONFIG_MISMATCH'] });
}

// ------------------------------------------------------------ runs (--parent)

{
  const parent = experimentalBase({ run: 'run-1' });
  parent.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  const parentText = parent.text();
  const bytes = Buffer.from(parentText, 'utf8');
  const derives = (override = {}) => ({
    leanRunId: 'run-1',
    reason: 'recovery_after_corruption',
    parentByteLength: bytes.length,
    parentPrefixSha256: sha256(bytes),
    parentLastSequences: { 'lean-estimator': 0, 'lean-hint': null },
    parentValidation: { status: 'failed', errorCodes: ['SEQUENCE_CONFLICT'] },
    coverage: { fromMonotonicUs: T0, toMonotonicUs: T0 + 1000000, complete: false },
    ...override,
  });
  const child = new LeanLog({ run: 'run-2' });
  child.started({ derivesFrom: derives() });
  child.reset();
  child.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  runCase('valid', '01-derived-run-matches-parent-prefix', parentText, child);

  const wrong = new LeanLog({ run: 'run-2' });
  wrong.started({ derivesFrom: derives({ parentPrefixSha256: sha256('another file') }) });
  wrong.reset();
  wrong.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  runCase('invalid', '01-parent-hash-mismatch', parentText, wrong, { expected: ['DERIVED_RUN_PARENT_MISMATCH'] });

  const short = new LeanLog({ run: 'run-2' });
  short.started({ derivesFrom: derives({ parentByteLength: bytes.length + 10 }) });
  short.reset();
  short.estimate({ angle: null, calibration: null, flags: EXP, t: T0 });
  runCase('invalid', '02-parent-shorter-than-declared', parentText, short, { expected: ['DERIVED_RUN_PARENT_MISMATCH'] });
}

addRegressionCases(out);

export { out, root };

// ------------------------------------------------------------ write / check

function main() {
  const check = process.argv.includes('--check');
  const problems = [];
  const expectedPaths = new Set(out.keys());
  for (const [path, content] of out) {
    const target = join(root, path);
    if (check) {
      if (!existsSync(target)) problems.push(`missing ${path}`);
      else if (readFileSync(target, 'utf8') !== content) problems.push(`drift ${path}`);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  for (const prefix of MANAGED) {
    const dir = join(root, prefix);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const rel = relative(root, file);
      if (expectedPaths.has(rel)) continue;
      if (check) problems.push(`unexpected ${rel}`);
      else rmSync(file);
    }
  }
  if (check) {
    if (problems.length > 0) {
      process.stderr.write(`v2 fixtures are out of date (run node test/build-v2-fixtures.mjs):\n  ${problems.join('\n  ')}\n`);
      process.exit(1);
    }
    process.stdout.write(`${out.size} v2 fixture files match the builders\n`);
  } else {
    process.stdout.write(`wrote ${out.size} v2 fixture files\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
