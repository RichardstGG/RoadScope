// Synthetic consumer-side review probes. Never reads private recordings.
// Usage: node review_c1_contract.mjs /path/to/C1-checkout
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

assert(process.argv[2], 'Pass a C1 checkout with contracts/tools dependencies installed');
const root = path.resolve(process.argv[2]);
const { validateMotionLog, validateLeanLog } = await import(
  pathToFileURL(path.join(root, 'contracts/tools/validate-motion-lean.mjs'))
);
const read = (relative) => fs.readFileSync(path.join(root,
  'testdata/contracts/motion-lean/v2', relative), 'utf8').trim().split('\n').map(JSON.parse);
const ndjson = (rows) => rows.map(JSON.stringify).join('\n') + '\n';
const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, sort(v[key])])) : v;
let bypasses = 0;
function expectRejected(name, result) {
  console.log(JSON.stringify({ name, rejected: !result.ok, findings: result.findings }));
  if (result.ok) bypasses++;
}

const motion = read('motion/valid/01b-time-bucket-minimal.ndjson');
assert.equal(validateMotionLog(ndjson(motion)).ok, true, 'motion baseline');
motion.find((r) => r.eventType === 'selection_anchor').anchorUs = 2000000000;
motion.filter((r) => r.recordType === 'motion_sample').forEach((r, i) => {
  r.measurementMonotonicUs = 1000000000 + i * 1000;
  r.receivedMonotonicUs = r.measurementMonotonicUs + 1500;
});
expectRejected('C1-1: future anchor and three samples in one 20ms bucket',
  validateMotionLog(ndjson(motion)));

const hints = read('lean/valid/05a-auto-reference-never-suspended.ndjson');
assert.equal(validateLeanLog(ndjson(hints)).ok, true, 'hint baseline');
const unavailable = { ...hints[2], eventType: 'estimator_state',
  state: 'unavailable', reason: 'input_interrupted' };
delete unavailable.afterInputs;
hints.splice(3, 0, unavailable);
hints[0].replayScope.calibration = true;
expectRejected('C1-2: enabled then unavailable then hints, claiming calibration replay',
  validateLeanLog(ndjson(hints)));

const paired = 'pairs/valid/04-qualified-config-matches-declarations/';
const raw = validateMotionLog(ndjson(read(paired + 'motion.ndjson')));
assert.equal(raw.ok, true, 'paired motion baseline');
const lean = read(paired + 'lean.ndjson');
assert.equal(validateLeanLog(ndjson(lean), { motion: raw }).ok, true, 'qualification baseline');
const qualification = lean[0].qualification;
qualification.qualifiedConfiguration.inputs[0].sourceId = 'undeclared-sensor';
qualification.configurationFingerprint = createHash('sha256')
  .update(JSON.stringify(sort(qualification.qualifiedConfiguration))).digest('hex');
expectRejected('C1-3: qualified configuration names an undeclared input',
  validateLeanLog(ndjson(lean), { motion: raw }));

// Recovery must not erase the missing reset/disabled transition from an interruption.
const recovery = read('lean/valid/05a-auto-reference-never-suspended.ndjson');
assert.equal(validateLeanLog(ndjson(recovery)).ok, true, 'recovery baseline');
recovery[0].replayScope.calibration = true;
const stateBase = recovery[2];
const blocked = { ...stateBase, eventType: 'estimator_state',
  state: 'unavailable', reason: 'input_interrupted' };
delete blocked.afterInputs;
const available = { ...blocked, state: 'available', reason: null };
const resetEpoch = { ...recovery[1], filterEpoch: 1, reason: 'input_clock_state_change' };
const reenabled = { ...stateBase, reason: 'estimator_available' };
recovery.splice(3, 0, blocked, available, resetEpoch, reenabled);
expectRejected('C1-2 recovery: enabled after recovery erases missing reset/disabled history',
  validateLeanLog(ndjson(recovery)));

console.log(`${bypasses} invalid case(s) incorrectly accepted`);
process.exitCode = bypasses ? 1 : 0;
