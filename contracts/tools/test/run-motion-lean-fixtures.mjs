#!/usr/bin/env node
// Asserts that every motion/lean contract fixture lands on the side it belongs to:
//   valid/   must produce no errors (warnings are allowed and expected)
//   invalid/ must produce every error code named in its .expected sibling
//   pairs/   a motion.ndjson + lean.ndjson validated together (cross-file refs)
// Also asserts location-log v1 compatibility: the existing location-log
// validator must tolerate every valid motion/lean line as an unknown record
// type, never as a sample or event and never as an error.
// Run with: npm test --prefix contracts/tools

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { validateMotionLog, validateLeanLog } from '../validate-motion-lean.mjs';
import { validateLocationLog } from '../validate-location-log.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../testdata/contracts/motion-lean/v1');

const failures = [];
let checked = 0;

const read = (path) => readFileSync(path, 'utf8');
const names = (dir, suffix = '.ndjson') =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(suffix)).sort() : [];

function errorsOf(result) {
  return result.findings.filter((f) => f.severity === 'error');
}

function expectWarnings(label, warningsPath, result) {
  if (!existsSync(warningsPath)) return;
  checked += 1;
  const expected = read(warningsPath).split('\n').map((l) => l.trim()).filter(Boolean);
  const reported = new Set(result.findings.filter((f) => f.severity === 'warn').map((f) => f.code));
  const missing = expected.filter((code) => !reported.has(code));
  if (missing.length > 0) failures.push(`${label} missing expected warning(s) ${missing.join(', ')}; reported ${[...reported].join(', ') || 'none'}`);
}

function expectValid(label, result, { requireRecords = true } = {}) {
  checked += 1;
  if (!result.ok) {
    const detail = errorsOf(result).map((f) => `line ${f.line} ${f.code}: ${f.detail}`).join('\n      ');
    failures.push(`${label} should pass but reported:\n      ${detail}`);
    return;
  }
  const count = result.kind === 'motion' ? result.samples : result.records;
  if (requireRecords && count === 0) failures.push(`${label} contains no data records`);
}

function expectInvalid(label, expectedPath, result) {
  checked += 1;
  if (!existsSync(expectedPath)) {
    failures.push(`${label} has no .expected file naming its error codes`);
    return;
  }
  const expected = read(expectedPath).split('\n').map((l) => l.trim()).filter(Boolean);
  if (expected.length === 0) {
    failures.push(`${label} has an empty .expected file`);
    return;
  }
  if (result.ok) {
    failures.push(`${label} should fail but passed`);
    return;
  }
  const reported = new Set(errorsOf(result).map((f) => f.code));
  const missing = expected.filter((code) => !reported.has(code));
  if (missing.length > 0) {
    failures.push(`${label} missing expected error code(s) ${missing.join(', ')}; reported ${[...reported].join(', ') || 'none'}`);
  }
}

// location-log v1 compatibility: nothing here may be read as a location record.
function expectLocationLogTolerates(label, text) {
  checked += 1;
  const result = validateLocationLog(text);
  if (!result.ok || result.samples !== 0 || result.events !== 0) {
    failures.push(
      `${label}: location-log v1 validator must treat every line as an unknown record type ` +
        `(ok=${result.ok}, samples=${result.samples}, events=${result.events})`,
    );
  }
}

for (const name of names(join(root, 'motion/valid'))) {
  const text = read(join(root, 'motion/valid', name));
  const result = validateMotionLog(text);
  expectValid(`motion/valid/${name}`, result);
  expectWarnings(`motion/valid/${name}`, join(root, 'motion/valid', name.replace(/\.ndjson$/, '.warnings')), result);
  expectLocationLogTolerates(`motion/valid/${name}`, text);
}
for (const name of names(join(root, 'motion/invalid'))) {
  const path = join(root, 'motion/invalid', name);
  expectInvalid(`motion/invalid/${name}`, path.replace(/\.ndjson$/, '.expected'), validateMotionLog(read(path)));
}
for (const name of names(join(root, 'lean/valid'))) {
  const text = read(join(root, 'lean/valid', name));
  const result = validateLeanLog(text);
  expectValid(`lean/valid/${name}`, result);
  expectWarnings(`lean/valid/${name}`, join(root, 'lean/valid', name.replace(/\.ndjson$/, '.warnings')), result);
  expectLocationLogTolerates(`lean/valid/${name}`, text);
}
for (const name of names(join(root, 'lean/invalid'))) {
  const path = join(root, 'lean/invalid', name);
  expectInvalid(`lean/invalid/${name}`, path.replace(/\.ndjson$/, '.expected'), validateLeanLog(read(path)));
}

for (const kind of ['valid', 'invalid']) {
  const dir = join(root, 'pairs', kind);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir).sort()) {
    const motionText = read(join(dir, name, 'motion.ndjson'));
    const leanPath = join(dir, name, 'lean.ndjson');
    const motion = validateMotionLog(motionText);
    // The motion half of every pair must itself be clean; the lean half is
    // checked with and without its motion companion.
    expectValid(`pairs/${kind}/${name}/motion`, motion);
    const alone = validateLeanLog(read(leanPath));
    const paired = validateLeanLog(read(leanPath), { motion });
    if (kind === 'valid') {
      expectValid(`pairs/valid/${name}/lean (paired)`, paired);
      expectValid(`pairs/valid/${name}/lean (standalone)`, alone);
    } else {
      expectInvalid(`pairs/invalid/${name}`, leanPath.replace(/\.ndjson$/, '.expected'), paired);
      // Cross-file rules must be opt-in: alone, the same lean log is well-formed.
      expectValid(`pairs/invalid/${name}/lean (standalone)`, alone);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.length} of ${checked} motion/lean check(s) failed:\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`${checked} motion/lean fixture check(s) behaved as specified\n`);
