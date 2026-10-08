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
import { validateMotionLog as legacyValidateMotionLog, validateLeanLog as legacyValidateLeanLog } from './legacy/validate-motion-lean.7474933.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const roots = ['v1', 'v2'].map((v) => ({ version: v, dir: resolve(here, `../../../testdata/contracts/motion-lean/${v}`) }));

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
  const absentPath = expectedPath.replace(/\.expected$/, '.absent');
  if (existsSync(absentPath)) {
    const absent = read(absentPath).split('\n').map((l) => l.trim()).filter(Boolean);
    const present = absent.filter((code) => reported.has(code));
    if (present.length > 0) failures.push(`${label} must NOT report ${present.join(', ')}`);
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

for (const { version, dir: root } of roots) {
  if (!existsSync(root)) continue;
  for (const name of names(join(root, 'motion/valid'))) {
    const text = read(join(root, 'motion/valid', name));
    const result = validateMotionLog(text);
    expectValid(`${version}/motion/valid/${name}`, result);
    expectWarnings(`${version}/motion/valid/${name}`, join(root, 'motion/valid', name.replace(/\.ndjson$/, '.warnings')), result);
    expectLocationLogTolerates(`${version}/motion/valid/${name}`, text);
  }
  for (const name of names(join(root, 'motion/invalid'))) {
    const path = join(root, 'motion/invalid', name);
    expectInvalid(`${version}/motion/invalid/${name}`, path.replace(/\.ndjson$/, '.expected'), validateMotionLog(read(path)));
  }
  for (const name of names(join(root, 'lean/valid'))) {
    const text = read(join(root, 'lean/valid', name));
    const result = validateLeanLog(text);
    expectValid(`${version}/lean/valid/${name}`, result);
    expectWarnings(`${version}/lean/valid/${name}`, join(root, 'lean/valid', name.replace(/\.ndjson$/, '.warnings')), result);
    expectLocationLogTolerates(`${version}/lean/valid/${name}`, text);
  }
  for (const name of names(join(root, 'lean/invalid'))) {
    const path = join(root, 'lean/invalid', name);
    expectInvalid(`${version}/lean/invalid/${name}`, path.replace(/\.ndjson$/, '.expected'), validateLeanLog(read(path)));
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
      expectValid(`${version}/pairs/${kind}/${name}/motion`, motion);
      const alone = validateLeanLog(read(leanPath));
      const paired = validateLeanLog(read(leanPath), { motion });
      if (kind === 'valid') {
        expectValid(`${version}/pairs/valid/${name}/lean (paired)`, paired);
        expectValid(`${version}/pairs/valid/${name}/lean (standalone)`, alone);
      } else {
        expectInvalid(`${version}/pairs/invalid/${name}`, leanPath.replace(/\.ndjson$/, '.expected'), paired);
        // Cross-file rules must be opt-in: alone, the same lean log is well-formed.
        expectValid(`${version}/pairs/invalid/${name}/lean (standalone)`, alone);
      }
    }
  }

  // runs/: a derived lean run checked against the parent file it derives from (--parent).
  for (const kind of ['valid', 'invalid']) {
    const dir = join(root, 'runs', kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const leanPath = join(dir, name, 'lean.ndjson');
      const parent = readFileSync(join(dir, name, 'parent.ndjson'));
      const label = `${version}/runs/${kind}/${name}`;
      const withParent = validateLeanLog(read(leanPath), { parent });
      if (kind === 'valid') {
        expectValid(`${label} (with parent)`, withParent);
        expectValid(`${label} (standalone)`, validateLeanLog(read(leanPath)));
      } else {
        expectInvalid(label, leanPath.replace(/\.ndjson$/, '.expected'), withParent);
        expectValid(`${label} (standalone)`, validateLeanLog(read(leanPath)));
      }
    }
  }
}

// v1/regression: the current tool against the documented outcome, and the frozen 7474933 tool
// against its recording (so the recorded "old" behaviour can never silently drift from the real one).
{
  const dir = resolve(here, '../../../testdata/contracts/motion-lean/v1/regression');
  if (existsSync(dir)) {
    const summarize = (r) => ({ ok: r.ok, findings: r.findings.map((f) => ({ code: f.code, severity: f.severity, line: f.line })) });
    const lines = (p) => (existsSync(p) ? read(p).split('\n').map((l) => l.trim()).filter(Boolean) : []);
    for (const name of readdirSync(dir).sort()) {
      const base = join(dir, name);
      const label = `v1/regression/${name}`;
      const leanText = read(join(base, 'lean.ndjson'));
      const motionPath = join(base, 'motion.ndjson');
      const motionText = existsSync(motionPath) ? read(motionPath) : null;

      const now = validateLeanLog(leanText, { motion: motionText ? validateMotionLog(motionText) : null });
      checked += 1;
      const want = read(join(base, 'new.result')).trim();
      if ((want === 'PASS') !== now.ok) failures.push(`${label}: current tool should ${want} but ${now.ok ? 'passed' : 'failed'}`);
      const reported = new Set(errorsOf(now).map((f) => f.code));
      for (const code of lines(join(base, 'new.expected'))) if (!reported.has(code)) failures.push(`${label}: current tool should report ${code}`);
      for (const code of lines(join(base, 'new.absent'))) if (reported.has(code)) failures.push(`${label}: current tool must NOT report ${code}`);

      checked += 1;
      const recorded = JSON.parse(read(join(base, 'old-tool.json')));
      const oldMotion = motionText ? legacyValidateMotionLog(motionText) : null;
      const oldLean = legacyValidateLeanLog(leanText, { motion: oldMotion });
      const actual = { tool: '7474933', ...(oldMotion ? { motion: summarize(oldMotion) } : {}), lean: summarize(oldLean) };
      if (JSON.stringify(actual) !== JSON.stringify(recorded)) failures.push(`${label}: old-tool.json differs from what the frozen 7474933 tool reports now`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.length} of ${checked} motion/lean check(s) failed:\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`${checked} motion/lean fixture check(s) behaved as specified\n`);
