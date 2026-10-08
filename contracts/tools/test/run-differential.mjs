#!/usr/bin/env node
// C2 equivalence: on every motion/lean fixture (v1, v2, pairs, runs, v1 regression) the current engine
// must reproduce the frozen C1 reference (test/legacy/validate-motion-lean.36662fa.mjs) exactly, with
// both index backends: same ok, counts and the same findings (code, severity, line, detail) in order.
// The CLI is compared too: text and --json output byte for byte, with --index memory and --index disk.
// Run with: npm test --prefix contracts/tools

import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as reference from './legacy/validate-motion-lean.36662fa.mjs';
import { validateLeanLog, validateMotionLog } from '../validate-motion-lean.mjs';
import { FileSink } from '../lib/io.mjs';
import { SqliteStore } from '../lib/store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tools = resolve(here, '..');
const root = resolve(here, '../../../testdata/contracts/motion-lean');
const work = mkdtempSync(join(tmpdir(), 'roadscope-differential-'));
const failures = [];
let checked = 0;
let serial = 0;

const read = (p) => readFileSync(p, 'utf8');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const strip = (r) => {
  const { model, findings, findingsFile, ...rest } = r;
  return rest;
};

function backends() {
  return [
    { name: 'memory', options: () => ({}), all: (r) => r.findings },
    {
      name: 'disk',
      options: () => {
        serial += 1;
        const sink = new FileSink(join(work, `f${serial}.jsonl`));
        return { store: new SqliteStore(join(work, `s${serial}.sqlite`)), sink };
      },
      all: (r, o) => [...o.sink.all()],
    },
  ];
}

function compare(label, expected, actual, actualFindings) {
  checked += 1;
  const a = JSON.stringify({ ...strip(expected), findings: expected.findings });
  const b = JSON.stringify({ ...strip(actual), findings: actualFindings });
  if (a !== b) failures.push(`${label}\n      C1: ${a.slice(0, 600)}\n      C2: ${b.slice(0, 600)}`);
}

const files = walk(root).filter((p) => p.endsWith('.ndjson'));
const pairDirs = new Set(files.filter((p) => /\/(pairs|regression)\//.test(p) && p.endsWith('motion.ndjson')).map(dirname));
const runDirs = new Set(files.filter((p) => /\/runs\//.test(p) && p.endsWith('parent.ndjson')).map(dirname));

for (const file of files) {
  const text = read(file);
  const label = file.slice(root.length + 1);
  for (const backend of backends()) {
    // Standalone, as the fixture runner and the CLI see each file.
    const o = backend.options();
    const motionKind = /"recordType":"motion_/.test(text);
    const leanKind = /"recordType":"lean_/.test(text);
    if (motionKind && !leanKind) {
      const r = validateMotionLog(text, o);
      compare(`${label} [motion, ${backend.name}]`, reference.validateMotionLog(text), r, backend.all(r, o));
    } else if (leanKind) {
      const r = validateLeanLog(text, o);
      compare(`${label} [lean, ${backend.name}]`, reference.validateLeanLog(text), r, backend.all(r, o));
    }
  }
}

for (const dir of pairDirs) {
  const motionText = read(join(dir, 'motion.ndjson'));
  const leanText = read(join(dir, 'lean.ndjson'));
  const label = dir.slice(root.length + 1);
  const refMotion = reference.validateMotionLog(motionText);
  const expected = reference.validateLeanLog(leanText, { motion: refMotion });
  for (const backend of backends()) {
    const om = backend.options();
    const motion = validateMotionLog(motionText, om);
    const ol = backend.options();
    const r = validateLeanLog(leanText, { ...ol, motion });
    compare(`${label} [paired, ${backend.name}]`, expected, r, backend.all(r, ol));
  }
}

for (const dir of runDirs) {
  const parent = readFileSync(join(dir, 'parent.ndjson'));
  const leanText = read(join(dir, 'lean.ndjson'));
  const label = dir.slice(root.length + 1);
  const expected = reference.validateLeanLog(leanText, { parent });
  for (const backend of backends()) {
    const o = backend.options();
    const r = validateLeanLog(leanText, { ...o, parent });
    compare(`${label} [parent, ${backend.name}]`, expected, r, backend.all(r, o));
  }
}

// CLI: byte-identical text and --json output against the C1 CLI, for both backends.
function cli(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: tools, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const legacyCli = join(here, 'legacy/validate-motion-lean.36662fa.mjs');
const currentCli = join(tools, 'validate-motion-lean.mjs');
// Batched (both CLIs accept several files) to keep the number of processes small; at most 8 files per
// run keeps each output well below a pipe buffer (the C1 CLI exits before stdout drains).
const cliCases = [];
const singles = files.filter((p) => !/\/(pairs|runs|regression)\//.test(p));
for (const dir of new Set(singles.map(dirname))) {
  const group = singles.filter((p) => dirname(p) === dir).sort();
  for (let i = 0; i < group.length; i += 8) cliCases.push(group.slice(i, i + 8));
}
for (const dir of pairDirs) cliCases.push(['--motion', join(dir, 'motion.ndjson'), join(dir, 'lean.ndjson')]);
for (const dir of runDirs) cliCases.push(['--parent', join(dir, 'parent.ndjson'), join(dir, 'lean.ndjson')]);
for (const args of cliCases) {
  for (const json of [false, true]) {
    const flags = json ? ['--json'] : [];
    const expected = cli(legacyCli, [...flags, ...args]);
    for (const index of ['memory', 'disk']) {
      checked += 1;
      const actual = cli(currentCli, ['--index', index, ...flags, ...args]);
      if (actual.status !== expected.status || actual.stdout !== expected.stdout) {
        failures.push(`CLI ${[...flags, ...args].map((a) => a.replace(root, '…')).join(' ')} [${index}]: exit ${expected.status} vs ${actual.status}${actual.stdout === expected.stdout ? '' : ', stdout differs'}${actual.stderr ? `\n      stderr: ${actual.stderr.slice(0, 300)}` : ''}`);
      }
    }
  }
}

rmSync(work, { recursive: true, force: true });
if (failures.length > 0) {
  process.stderr.write(`${failures.length} of ${checked} C1-equivalence check(s) failed:\n`);
  for (const failure of failures.slice(0, 40)) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`${checked} C1-equivalence check(s): both index backends and the CLI reproduce the C1 reference\n`);
