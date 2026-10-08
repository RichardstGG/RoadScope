#!/usr/bin/env node
// C2 capacity acceptance (0003 E.5). For each synthetic profile: generate (streaming), validate with the
// CLI on the disk index, and record peak RSS (getrusage of the child), wall time and peak temporary disk.
// A run passes only if it COMPLETES (no exit 3), reports every expected code, no unexpected error code,
// and its peak RSS is within --rss-budget-mib. A watchdog abort is a failure, never a pass.
// With --compare-reference (small sizes only) the findings must equal the frozen C1 reference too.
//   node test/run-large.mjs --bytes 2147483648 --dir <scratch dir on disk> [--profiles a,b] [--keep]
// Prints one JSON line per profile and a summary. Synthetic data only.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileInput } from '../lib/io.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tools = resolve(here, '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : pairs), []),
);
const bytes = Number(args.bytes ?? 64 * 2 ** 20);
if (!args.dir) {
  process.stderr.write('usage: run-large.mjs --dir <directory on a real disk, outside the repository> [--bytes n] [--profiles a,b] [--compare-reference] [--keep] [--clean-inputs]\n');
  process.exit(2);
}
const dir = resolve(args.dir);
const budget = Number(args['rss-budget-mib'] ?? 256) * 2 ** 20;
const profiles = (args.profiles ?? 'valid,tail-corrupt,long-duplicate,session-churn,dangling-refs,clock-churn,many-findings').split(',');
mkdirSync(dir, { recursive: true });

function dirBytes(path) {
  let total = 0;
  if (!existsSync(path)) return 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    try {
      total += entry.isDirectory() ? dirBytes(p) : statSync(p).size;
    } catch {
      // removed while walking
    }
  }
  return total;
}

function run(cliArgs, tmpDir) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(tools, 'validate-motion-lean.mjs'), ...cliArgs], {
      cwd: tools,
      env: { ...process.env, ROADSCOPE_VALIDATOR_STATS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      if (stdout.length < 1_000_000) stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    let peakTmp = 0;
    const poll = setInterval(() => {
      peakTmp = Math.max(peakTmp, dirBytes(tmpDir));
    }, 1000);
    child.on('close', (status) => {
      clearInterval(poll);
      const stats = JSON.parse((stderr.match(/STATS (.*)/) ?? [null, '{}'])[1]);
      done({ status, stdout, stderr: stderr.replace(/STATS .*\n?/, ''), wallMs: Date.now() - started, peakTmpBytes: peakTmp, ...stats });
    });
  });
}

const summary = [];
for (const profile of profiles) {
  const caseDir = join(dir, `${profile}-${bytes}`);
  let expected;
  const marker = join(caseDir, 'expected.json');
  if (existsSync(marker)) {
    expected = JSON.parse(readFileSync(marker, 'utf8'));
  } else {
    const gen = spawnSync(process.execPath, [join(here, 'gen-synthetic-large.mjs'), '--profile', profile, '--bytes', String(bytes), '--out', caseDir], { encoding: 'utf8' });
    if (gen.status !== 0) throw new Error(gen.stderr);
    expected = JSON.parse(gen.stdout);
    spawnSync('sh', ['-c', `cat > '${marker}'`], { input: gen.stdout });
  }
  const tmpDir = join(caseDir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const findingsFile = join(caseDir, 'findings.jsonl');
  const motion = join(caseDir, 'motion.ndjson');
  const lean = join(caseDir, 'lean.ndjson');
  const result = await run(['--index', 'disk', '--tmp-dir', tmpDir, '--summary', '--findings-out', findingsFile, '--motion', motion, motion, lean], tmpDir);

  const codes = new Map();
  if (existsSync(findingsFile)) {
    const input = new FileInput(findingsFile); // can be hundreds of MB: streamed and counted, not kept
    for (const { raw: line } of input.lines(Number.MAX_SAFE_INTEGER)) {
      if (!line) continue;
      const f = JSON.parse(line);
      const key = `${f.severity}:${f.code}`;
      codes.set(key, (codes.get(key) ?? 0) + 1);
    }
    input.close();
  }
  const errors = [...codes.keys()].filter((k) => k.startsWith('error:')).map((k) => k.slice(6));
  const warnings = [...codes.keys()].filter((k) => k.startsWith('warn:')).map((k) => k.slice(5));
  const problems = [];
  if (result.status === 3 || result.status === 130 || result.status === null) problems.push(`did not complete (exit ${result.status}): ${result.stderr.trim()}`);
  for (const code of expected.errors) if (!errors.includes(code)) problems.push(`missing ${code}`);
  for (const code of expected.warnings) if (!warnings.includes(code)) problems.push(`missing warning ${code}`);
  for (const code of errors) if (!expected.errors.includes(code)) problems.push(`unexpected ${code}`);
  const wantStatus = expected.errors.length ? 1 : 0;
  if (result.status !== wantStatus && !problems.length) problems.push(`exit ${result.status}, expected ${wantStatus}`);
  const rss = (result.maxRssKiB ?? 0) * 1024;
  if (!rss) problems.push('no RSS measurement');
  else if (rss > budget) problems.push(`peak RSS ${Math.round(rss / 2 ** 20)} MiB exceeds ${Math.round(budget / 2 ** 20)} MiB`);

  if (args['compare-reference']) {
    // Library-level comparison: the C1 CLI exits before stdout drains and truncates large piped outputs.
    const reference = await import('./legacy/validate-motion-lean.36662fa.mjs');
    const refMotion = reference.validateMotionLog(readFileSync(motion, 'utf8'));
    const refLean = reference.validateLeanLog(readFileSync(lean, 'utf8'), { motion: refMotion });
    // --motion only pairs; the listed files (motion, then lean) are what --findings-out holds.
    const expectedFindings = [...refMotion.findings.map((f) => ({ file: motion, ...f })), ...refLean.findings.map((f) => ({ file: lean, ...f }))];
    const now = spawnSync(process.execPath, [join(tools, 'validate-motion-lean.mjs'), '--index', 'disk', '--tmp-dir', tmpDir, '--summary', '--findings-out', `${findingsFile}.cmp`, '--motion', motion, motion, lean], { cwd: tools, encoding: 'utf8' });
    const actual = readFileSync(`${findingsFile}.cmp`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    rmSync(`${findingsFile}.cmp`, { force: true });
    if (JSON.stringify(actual) !== JSON.stringify(expectedFindings) || now.status !== (refMotion.ok && refLean.ok ? 0 : 1)) problems.push('findings differ from the C1 reference');
  }

  const line = {
    profile,
    pass: problems.length === 0,
    problems,
    exit: result.status,
    inputBytes: statSync(motion).size + statSync(lean).size,
    motionLines: expected.motionLines,
    leanLines: expected.leanLines,
    peakRssMiB: Math.round((rss / 2 ** 20) * 10) / 10,
    wallSeconds: Math.round(result.wallMs / 100) / 10,
    cpuSeconds: Math.round(((result.userMs ?? 0) + (result.systemMs ?? 0)) / 100) / 10,
    peakTmpMiB: Math.round(result.peakTmpBytes / 2 ** 20),
    findings: Object.fromEntries(codes),
  };
  summary.push(line);
  process.stdout.write(`${JSON.stringify(line)}\n`);
  if (!args.keep) rmSync(findingsFile, { force: true });
  rmSync(tmpDir, { recursive: true, force: true });
  if (args['clean-inputs']) rmSync(caseDir, { recursive: true, force: true }); // CI disks are small
}
const failed = summary.filter((s) => !s.pass);
process.stdout.write(`${summary.length - failed.length}/${summary.length} profile(s) passed at ${bytes} bytes\n`);
process.exit(failed.length ? 1 : 0);
