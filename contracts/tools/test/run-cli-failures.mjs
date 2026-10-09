#!/usr/bin/env node
// CLI execution failures (0003 A.3 X-1..X-4, E.3, E.4): an incomplete run is never a pass, the exit
// code says why, the temporary index is removed, and a killed run's leftovers are cleaned next time.
// Run with: npm test --prefix contracts/tools

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
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

// ---- C2-1: --findings-out must never be an input (same path, relative path, symlink, hardlink, and
// aliases of --motion / --parent). Refused before anything is truncated: exit 2, every input unchanged.
{
  const dir = join(work, 'alias');
  mkdirSync(dir);
  const base = readFileSync(valid);
  const motionFile = join(dir, 'motion.ndjson');
  const leanFile = join(dir, 'lean.ndjson');
  const parentFile = join(dir, 'parent.ndjson');
  writeFileSync(motionFile, base);
  writeFileSync(leanFile, readFileSync(join(fixtures, 'runs/valid/01-derived-run-matches-parent-prefix/lean.ndjson')));
  writeFileSync(parentFile, readFileSync(join(fixtures, 'runs/valid/01-derived-run-matches-parent-prefix/parent.ndjson')));
  const all = [motionFile, leanFile, parentFile];
  const hashes = () => all.map((p) => createHash('sha256').update(readFileSync(p)).digest('hex')).join(',');
  const before = hashes();
  symlinkSync(motionFile, join(dir, 'motion-link.jsonl'));
  linkSync(motionFile, join(dir, 'motion-hard.jsonl'));
  symlinkSync(parentFile, join(dir, 'parent-link.jsonl'));
  linkSync(leanFile, join(dir, 'lean-hard.jsonl'));
  const cases = [
    ['same path', [motionFile], motionFile],
    ['relative path', [motionFile], relative(tools, motionFile)],
    ['symlink', [motionFile], join(dir, 'motion-link.jsonl')],
    ['hardlink', [motionFile], join(dir, 'motion-hard.jsonl')],
    ['--motion alias', ['--motion', motionFile, leanFile], join(dir, 'motion-hard.jsonl')],
    ['--parent alias', ['--parent', parentFile, leanFile], join(dir, 'parent-link.jsonl')],
    ['lean input hardlink', ['--parent', parentFile, leanFile], join(dir, 'lean-hard.jsonl')],
  ];
  for (const [label, args, out] of cases) {
    const r = run(['--findings-out', out, ...args]);
    expect(`C2-1 ${label}: refused with exit 2`, r.status === 2 && /same file as the input/.test(r.stderr), `exit ${r.status} ${r.stderr}`);
    expect(`C2-1 ${label}: every input byte-identical`, hashes() === before);
  }
  const ok = run(['--findings-out', join(dir, 'separate.jsonl'), '--parent', parentFile, leanFile]);
  expect('C2-1 a separate output file is accepted', ok.status === 0 && hashes() === before, `exit ${ok.status} ${ok.stderr}`);
}

// ---- C2-2: findings found before an interruption are kept (streamed to --findings-out while validating,
// reported as INCOMPLETE on stdout or in --json), marked incomplete, never a PASS.
const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function expectRetained(label, r, findingsPath, exitCode) {
  const saved = readJsonl(findingsPath);
  expect(`${label}: exit ${exitCode}`, r.status === exitCode, `exit ${r.status} ${r.stderr.slice(0, 300)}`);
  expect(`${label}: --findings-out keeps NOT_JSON`, saved.some((f) => f.code === 'NOT_JSON'));
  expect(`${label}: --findings-out ends with VALIDATION_INCOMPLETE`, saved.at(-1)?.code === 'VALIDATION_INCOMPLETE');
  expect(`${label}: not reported as PASS`, !/^PASS/m.test(r.stdout) && /not a pass/.test(r.stderr));
}
{
  const dir = join(work, 'partial');
  mkdirSync(dir);
  const base = readFileSync(valid);
  const longLine = join(dir, 'long-line.ndjson');
  writeFileSync(longLine, Buffer.concat([base, Buffer.from('not-json\n'), Buffer.alloc(1024 * 1024 + 1, 120), Buffer.from('\n')]));
  expectRetained('C2-2 line too long', run(['--findings-out', join(dir, 'a.jsonl'), longLine]), join(dir, 'a.jsonl'), 3);
  const text = run([longLine]);
  expect('C2-2 without --findings-out: INCOMPLETE report with the findings so far', text.status === 3 && /^INCOMPLETE /m.test(text.stdout) && /NOT_JSON/.test(text.stdout), text.stdout.slice(0, 300));
  const json = run(['--json', longLine]);
  let parsed = null;
  try {
    parsed = JSON.parse(json.stdout);
  } catch {
    // reported below
  }
  expect('C2-2 --json stays valid JSON with complete:false and the findings so far', json.status === 3 && parsed?.[0]?.complete === false && parsed[0].ok === false && parsed[0].findings.some((f) => f.code === 'NOT_JSON'), json.stdout.slice(0, 300));

  // One valid log with a single NOT_JSON line after its first line: one finding, then enough valid data
  // for the resource checks to run.
  const early = join(dir, 'early-error.ndjson');
  const bigLog = readFileSync(join(big, 'motion.ndjson'));
  const firstLine = bigLog.indexOf(0x0a) + 1;
  writeFileSync(early, Buffer.concat([bigLog.subarray(0, firstLine), Buffer.from('not-json\n'), bigLog.subarray(firstLine)]));
  expectRetained('C2-2 RSS ceiling', run(['--index', 'disk', '--rss-limit-mib', '16', '--findings-out', join(dir, 'b.jsonl'), early]), join(dir, 'b.jsonl'), 3);

  // The index cannot grow: a file-size limit with SIGXFSZ ignored makes writes fail with EFBIG.
  const limited = spawnSync('sh', ['-c', `trap '' XFSZ; ulimit -f 4096; exec "$0" "$@"`, process.execPath, cli, '--index', 'disk', '--tmp-dir', dir, '--findings-out', join(dir, 'c.jsonl'), early], { cwd: tools, encoding: 'utf8' });
  expectRetained('C2-2 index write failure (EFBIG / disk full)', limited, join(dir, 'c.jsonl'), 3);
  expect('C2-2 index write failure removes its temporary directory', leftovers(dir).length === 0, leftovers(dir).join(','));

  // The findings output itself fails: nothing to keep there, but stdout still has the findings so far.
  if (existsSync('/dev/full')) {
    const full = run(['--findings-out', '/dev/full', early]);
    expect('C2-2 findings output failure: exit 3, findings so far on stdout', full.status === 3 && /^INCOMPLETE /m.test(full.stdout) && /NOT_JSON/.test(full.stdout), `exit ${full.status} ${full.stdout.slice(0, 200)} ${full.stderr.slice(0, 200)}`);
  }

  // Cancelled while validating: exit 130, findings so far kept.
  const out = join(dir, 'd.jsonl');
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [cli, '--index', 'disk', '--tmp-dir', dir, '--findings-out', out, early], { cwd: tools, stdio: 'ignore' });
    const timer = setInterval(() => {
      if (readJsonl(out).some((f) => f.code === 'NOT_JSON') || leftovers(dir).length > 0) {
        clearInterval(timer);
        child.kill('SIGINT');
      }
    }, 5);
    child.on('close', (status) => {
      clearInterval(timer);
      done(status);
    });
  });
  const saved = readJsonl(out);
  expect('C2-2 cancelled: exit 130 with findings so far and the incomplete marker', code === 130 && saved.some((f) => f.code === 'NOT_JSON') && saved.at(-1)?.code === 'VALIDATION_INCOMPLETE', `exit ${code}, ${saved.length} saved`);
}

// ---- C2-3: every scanning stage (format probe, unknown/blank prefixes, parent hashing, output replay)
// is bounded by the same line limit and guard. Judged by the child's real peak RSS (getrusage).
// The child's own peak (VmHWM): getrusage's maxRSS would also count this test process, which holds the
// large buffers it just wrote, because Linux keeps maxRSS across fork + exec.
const peakMiB = (r) => {
  const stats = JSON.parse(r.stderr.match(/STATS (.*)/)?.[1] ?? '{}');
  return (stats.vmHwmKiB ?? stats.maxRssKiB ?? Infinity) / 1024;
};
{
  const dir = join(work, 'probe');
  mkdirSync(dir);
  const base = readFileSync(valid);
  const oversized = join(dir, 'oversized-first-line.ndjson');
  writeFileSync(oversized, Buffer.concat([Buffer.alloc(64 * 2 ** 20, 120), Buffer.from('\n'), base]));
  const r = run([oversized], { ROADSCOPE_VALIDATOR_STATS: '1' });
  expect('C2-3 64 MiB first line: LINE_TOO_LONG, exit 3', r.status === 3 && /LINE_TOO_LONG/.test(r.stderr), r.stderr.slice(0, 200));
  expect('C2-3 64 MiB first line: peak RSS stays low (refused while reading)', peakMiB(r) <= 160, `${peakMiB(r).toFixed(1)} MiB`);

  const junk = join(dir, 'junk-prefix.ndjson');
  writeFileSync(junk, Buffer.concat([Buffer.from('\n'.repeat(100_000)), Buffer.from('{"recordType":"something_else"}\n'.repeat(100_000)), base]));
  // 100,000 UNKNOWN_RECORD_TYPE warnings: keep stdout short (spawnSync buffers it), all go to the file.
  const j = run(['--summary', '--findings-out', join(dir, 'junk.jsonl'), junk], { ROADSCOPE_VALIDATOR_STATS: '1' });
  expect('C2-3 blank and unknown prefix lines are scanned, then the log is validated', j.status === 0 && /^PASS/m.test(j.stdout), `exit ${j.status} ${j.stderr.slice(0, 200)}`);

  const junkLong = join(dir, 'junk-then-oversized.ndjson');
  writeFileSync(junkLong, Buffer.concat([Buffer.from('{"recordType":"something_else"}\n'.repeat(1000)), Buffer.alloc(16 * 2 ** 20, 120), Buffer.from('\n'), base]));
  const jl = run([junkLong], { ROADSCOPE_VALIDATOR_STATS: '1' });
  expect('C2-3 oversized line after an unknown prefix: exit 3 while probing, bounded', jl.status === 3 && /LINE_TOO_LONG/.test(jl.stderr) && peakMiB(jl) <= 160, `exit ${jl.status} ${peakMiB(jl).toFixed(1)} MiB\n${jl.stderr.slice(0, 500)}`);

  // --parent is hashed in chunks: a 64 MiB parent without a single newline costs no memory.
  const parentDir = join(fixtures, 'runs/valid/01-derived-run-matches-parent-prefix');
  const hugeParent = join(dir, 'huge-parent.ndjson');
  writeFileSync(hugeParent, Buffer.concat([readFileSync(join(parentDir, 'parent.ndjson')), Buffer.alloc(64 * 2 ** 20, 120)]));
  const p = run(['--parent', hugeParent, join(parentDir, 'lean.ndjson')], { ROADSCOPE_VALIDATOR_STATS: '1' });
  expect('C2-3 64 MiB parent: prefix verified, peak RSS stays low', p.status === 0 && peakMiB(p) <= 160, `exit ${p.status} ${peakMiB(p).toFixed(1)} MiB ${p.stderr.slice(0, 200)}`);
}

// ---- C2-3: a cancellation while the findings output drains is honoured (exit 130).
{
  const manyDir = join(work, 'many');
  const g = spawnSync(process.execPath, [join(here, 'gen-synthetic-large.mjs'), '--profile', 'many-findings', '--bytes', String(4 * 2 ** 20), '--out', manyDir], { encoding: 'utf8' });
  expect('generator (many findings)', g.status === 0, g.stderr);
  const result = await new Promise((done) => {
    const child = spawn(process.execPath, [cli, join(manyDir, 'motion.ndjson')], { cwd: tools, stdio: ['ignore', 'pipe', 'pipe'] });
    let signalled = false;
    child.stdout.on('data', () => {
      if (signalled) return;
      signalled = true;
      child.stdout.pause();
      child.kill('SIGINT');
      setTimeout(() => child.stdout.resume(), 200);
    });
    child.stderr.resume();
    child.on('close', (status) => done({ status, signalled }));
  });
  expect('C2-3 SIGINT while output drains: exit 130', result.signalled && result.status === 130, `exit ${result.status}`);
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
