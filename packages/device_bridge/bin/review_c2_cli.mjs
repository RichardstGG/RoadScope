// Consumer review of C2 execution failures. Uses synthetic temporary copies only.
// Usage: node review_c2_cli.mjs /path/to/C2-checkout
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

assert(process.argv[2], 'Pass a C2 checkout with lockfile dependencies installed');
const root = path.resolve(process.argv[2]);
const cli = path.join(root, 'contracts/tools/validate-motion-lean.mjs');
const base = fs.readFileSync(path.join(root,
  'testdata/contracts/motion-lean/v2/motion/valid/01b-time-bucket-minimal.ndjson'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'roadscope-c2-consumer-'));
const digest = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let failures = 0;
const run = (args) => {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', env: { ...process.env, ROADSCOPE_VALIDATOR_STATS: '1' },
  });
  if (r.error) throw r.error; // A blocked child process is not a validation result.
  return r;
};
function check(name, passed, details) {
  console.log(JSON.stringify({ name, passed, ...details }));
  if (!passed) failures++;
}
try {
  const input = path.join(work, 'baseline.ndjson');
  fs.writeFileSync(input, base);
  assert.equal(run([input]).status, 0, 'synthetic baseline');
  for (const alias of ['same-path', 'symlink', 'hardlink']) {
    const source = path.join(work, `${alias}.ndjson`);
    const output = alias === 'same-path' ? source : path.join(work, `${alias}.jsonl`);
    fs.writeFileSync(source, base);
    if (alias === 'symlink') fs.symlinkSync(source, output);
    if (alias === 'hardlink') fs.linkSync(source, output);
    const before = digest(source);
    const r = run(['--findings-out', output, source]);
    check(`C2-1: reject findings/input alias (${alias})`,
      [2, 3].includes(r.status) && digest(source) === before,
      { exit: r.status, preserved: digest(source) === before });
  }

  const partial = path.join(work, 'partial.ndjson');
  const findings = path.join(work, 'partial.jsonl');
  fs.writeFileSync(partial, Buffer.concat([
    base, Buffer.from('not-json\n'), Buffer.alloc(1024 * 1024 + 1, 120), Buffer.from('\n'),
  ]));
  const incomplete = run(['--findings-out', findings, partial]);
  const saved = fs.existsSync(findings) ? fs.readFileSync(findings, 'utf8') : '';
  check('C2-2: retain discovered findings after capacity failure',
    incomplete.status === 3 && saved.includes('NOT_JSON') && !incomplete.stdout.includes('PASS'),
    { exit: incomplete.status, retainedNotJson: saved.includes('NOT_JSON') });

  const oversized = path.join(work, 'oversized-first-line.ndjson');
  // Keep the test parent small too: Linux getrusage can include its image at fork.
  const fd = fs.openSync(oversized, 'w');
  try {
    const chunk = Buffer.alloc(64 * 1024, 120);
    for (let i = 0; i < 1024; i++) fs.writeSync(fd, chunk);
    fs.writeSync(fd, Buffer.concat([Buffer.from('\n'), base]));
  } finally { fs.closeSync(fd); }
  const capacity = run([oversized]);
  const stats = JSON.parse(capacity.stderr.match(/STATS (.*)/)?.[1] ?? '{}');
  const rssMiB = Math.max(stats.maxRssKiB ?? Infinity, stats.vmHwmKiB ?? 0) / 1024;
  check('C2-3: enforce line cap before kind/version detection allocates oversized line',
    capacity.status === 3 && /LINE_TOO_LONG/.test(capacity.stderr) && rssMiB > 0 && rssMiB <= 256,
    { exit: capacity.status, peakRssMiB: rssMiB, vmHwmMiB: stats.vmHwmKiB / 1024 });

  const first = path.join(work, 'completed-first.ndjson');
  fs.writeFileSync(first, Buffer.concat([base, Buffer.from('not-json\n')]));
  const second = path.join(work, 'probe-failure.ndjson');
  fs.writeFileSync(second, Buffer.alloc(1024 * 1024 + 1, 120));
  const multiText = run([first, second]);
  check('C2-4: retain completed text results when next file fails probing',
    multiText.status === 3 && multiText.stdout.includes('NOT_JSON') &&
      multiText.stdout.includes('INCOMPLETE') && multiText.stdout.includes(second),
    { exit: multiText.status, stdoutBytes: Buffer.byteLength(multiText.stdout) });
  for (const files of [[second], [first, second]]) {
    const result = run(['--json', ...files]);
    let entries;
    try { entries = JSON.parse(result.stdout); } catch { /* assertion below */ }
    check(`C2-4: finalise JSON after probe failure (${files.length} input file(s))`,
      result.status === 3 && Array.isArray(entries) &&
      entries.some((e) => e.file === second && e.complete === false) &&
      (files.length === 1 || entries.some((e) => e.file === first &&
        e.findings?.some((f) => f.code === 'NOT_JSON'))),
      { exit: result.status, validJson: Array.isArray(entries), stdoutBytes: Buffer.byteLength(result.stdout) });
  }

  const cancelDir = path.join(work, 'output-cancel');
  const generated = spawnSync(process.execPath, [path.join(root,
    'contracts/tools/test/gen-synthetic-large.mjs'), '--profile', 'many-findings',
    '--bytes', String(4 * 1024 * 1024), '--out', cancelDir], { encoding: 'utf8' });
  if (generated.error) throw generated.error;
  assert.equal(generated.status, 0, generated.stderr);
  const cancelled = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, path.join(cancelDir, 'motion.ndjson')],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let signalled = false;
    let stderr = '';
    let resumeTimer;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', () => {
      if (signalled) return;
      signalled = true;
      child.stdout.pause();
      child.kill('SIGINT');
      resumeTimer = setTimeout(() => child.stdout.resume(), 200);
    });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      clearTimeout(resumeTimer);
      resolve({ status, signal, signalled, stderr });
    });
  });
  check('C2-3: honour SIGINT while findings output is draining',
    cancelled.signalled && cancelled.status === 130,
    { exit: cancelled.status, signal: cancelled.signal, sigintSent: cancelled.signalled });

  const jsonCancelled = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--json', path.join(cancelDir, 'motion.ndjson')],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let signalled = false;
    let stdout = '';
    let resumeTimer;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (signalled) return;
      signalled = true;
      child.stdout.pause();
      child.kill('SIGINT');
      resumeTimer = setTimeout(() => child.stdout.resume(), 200);
    });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      clearTimeout(resumeTimer);
      let entries;
      try { entries = JSON.parse(stdout); } catch { /* assertion below */ }
      resolve({ status, signal, signalled, entries, stdout });
    });
  });
  check('C2-4: finalise JSON after one SIGINT during output (stdout stays writable)',
    jsonCancelled.signalled && jsonCancelled.status === 130 &&
    Array.isArray(jsonCancelled.entries) && jsonCancelled.entries.some((e) => e.complete === false),
    { exit: jsonCancelled.status, validJson: Array.isArray(jsonCancelled.entries),
      sigintSent: jsonCancelled.signalled, stdoutBytes: Buffer.byteLength(jsonCancelled.stdout) });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`${failures} C2 consumer rejection check(s) failed`);
process.exitCode = failures ? 1 : 0;
