#!/usr/bin/env node
// CLI execution failures (0003 A.3 X-1..X-4, E.3, E.4): an incomplete run is never a pass, the exit
// code says why, the temporary index is removed, and a killed run's leftovers are cleaned next time.
// Run with: npm test --prefix contracts/tools

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tools = resolve(here, '..');
const cli = join(tools, 'validate-motion-lean.mjs');
const fixtures = resolve(here, '../../../testdata/contracts/motion-lean/v2');
const valid = join(fixtures, 'motion/valid/01b-time-bucket-minimal.ndjson');
const work = mkdtempSync(join(tmpdir(), 'roadscope-cli-failures-'));
const failures = [];
let checked = 0;

const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: tools, encoding: 'utf8', env: { ...process.env, ...env } });
const leftovers = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('roadscope-validate-')) : []);
function expect(label, condition, detail = '') {
  checked += 1;
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

// A big synthetic input, so that resource checks (every 4096 lines) are reached.
const big = join(work, 'big');
const gen = spawnSync(process.execPath, [join(here, 'gen-synthetic-large.mjs'), '--profile', 'valid', '--bytes', String(8 * 2 ** 20), '--out', big], { encoding: 'utf8' });
expect('generator', gen.status === 0, gen.stderr);

{
  const tmp = join(work, 't-line');
  mkdirSync(tmp);
  const r = run(['--tmp-dir', tmp, '--max-line-bytes', '100', valid]);
  expect('line too long exits 3', r.status === 3, `exit ${r.status}`);
  expect('line too long is not reported as PASS', !/PASS/.test(r.stdout) && /not a pass/.test(r.stderr), r.stderr);
  expect('line too long removes its temporary directory', leftovers(tmp).length === 0, leftovers(tmp).join(','));
}
{
  const tmp = join(work, 't-rss');
  mkdirSync(tmp);
  const r = run(['--index', 'disk', '--tmp-dir', tmp, '--rss-limit-mib', '16', join(big, 'motion.ndjson')]);
  expect('RSS ceiling exits 3', r.status === 3, `exit ${r.status} ${r.stderr}`);
  expect('RSS ceiling says RSS_LIMIT and not a pass', /RSS_LIMIT/.test(r.stderr) && /not a pass/.test(r.stderr) && !/PASS/.test(r.stdout), r.stderr);
  expect('RSS ceiling removes its temporary directory', leftovers(tmp).length === 0);
}
{
  const r = run(['--summary', valid]);
  expect('--summary without --findings-out is a usage error', r.status === 2, `exit ${r.status}`);
  const u = run(['--index', 'sometimes', valid]);
  expect('bad --index is a usage error', u.status === 2);
  const n = run([]);
  expect('no file is a usage error', n.status === 2);
}
{
  const unsupported = join(fixtures, 'motion/invalid/02-unsupported-schema-version.ndjson');
  const r = run([unsupported]);
  expect('unsupported schemaVersion exits 4 for any backend', r.status === 4 && run(['--index', 'disk', unsupported]).status === 4);
}
{
  // --summary keeps stdout short, --findings-out holds everything.
  const out = join(work, 'findings.jsonl');
  const invalid = join(fixtures, 'motion/invalid/16a-future-anchor-hides-bucket-violation.ndjson');
  const r = run(['--summary', '--findings-out', out, invalid]);
  const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect('--findings-out holds every finding with its file', r.status === 1 && lines.length > 0 && lines.every((f) => f.file === invalid && f.code));
}
{
  // Stale leftovers of a killed run: removed only when ours, old and dead.
  const tmp = join(work, 't-stale');
  mkdirSync(tmp);
  const stale = join(tmp, 'roadscope-validate-dead');
  const alive = join(tmp, 'roadscope-validate-alive');
  const young = join(tmp, 'roadscope-validate-young');
  const foreign = join(tmp, 'roadscope-validate-foreign');
  for (const [dir, pid, host] of [[stale, 999999, hostname()], [alive, process.pid, hostname()], [young, 999999, hostname()], [foreign, 999999, 'another-host']]) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid, host }));
    writeFileSync(join(dir, 'index.sqlite'), 'x');
  }
  const old = new Date(Date.now() - 2 * 3600_000);
  for (const dir of [stale, alive, foreign]) utimesSync(dir, old, old);
  const r = run(['--tmp-dir', tmp, valid]);
  expect('stale cleanup removes a dead, old run of ours', !existsSync(stale) && /removed stale/.test(r.stderr), r.stderr);
  expect('stale cleanup keeps a live run, a young one and another host', existsSync(alive) && existsSync(young) && existsSync(foreign));
}

// SIGINT while validating: exit 130, temporary directory removed. The input must take long enough to
// still be running when the signal arrives.
{
  const slow = join(work, 'slow');
  const g = spawnSync(process.execPath, [join(here, 'gen-synthetic-large.mjs'), '--profile', 'valid', '--bytes', String(64 * 2 ** 20), '--out', slow], { encoding: 'utf8' });
  expect('generator (slow input)', g.status === 0, g.stderr);
  const tmp = join(work, 't-sigint');
  mkdirSync(tmp);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [cli, '--index', 'disk', '--tmp-dir', tmp, join(slow, 'motion.ndjson')], { cwd: tools, stdio: 'ignore' });
    const timer = setInterval(() => {
      if (leftovers(tmp).length > 0) {
        clearInterval(timer);
        setTimeout(() => child.kill('SIGINT'), 50);
      }
    }, 20);
    child.on('close', (status) => {
      clearInterval(timer);
      done(status);
    });
  });
  expect('SIGINT exits 130', code === 130, `exit ${code}`);
  expect('SIGINT removes the temporary directory', leftovers(tmp).length === 0, leftovers(tmp).join(','));
}

rmSync(work, { recursive: true, force: true });
if (failures.length > 0) {
  process.stderr.write(`${failures.length} of ${checked} CLI failure check(s) failed:\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`${checked} CLI failure check(s) behaved as specified\n`);
