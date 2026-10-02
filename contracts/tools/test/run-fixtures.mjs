#!/usr/bin/env node
// Asserts that every contract fixture lands on the side it belongs to:
//   valid/   must produce no errors (warnings are allowed and expected)
//   invalid/ must produce every error code named in its .expected sibling
// Run with: npm test --prefix contracts/tools

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { validateLocationLog } from '../validate-location-log.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../../testdata/contracts/location-log/v1');

const failures = [];
let checked = 0;

function logsIn(kind) {
  return readdirSync(join(fixtures, kind))
    .filter((name) => name.endsWith('.ndjson'))
    .sort();
}

for (const name of logsIn('valid')) {
  checked += 1;
  const path = join(fixtures, 'valid', name);
  const result = validateLocationLog(readFileSync(path, 'utf8'));
  if (!result.ok) {
    const detail = result.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => `line ${finding.line} ${finding.code}: ${finding.detail}`)
      .join('\n      ');
    failures.push(`valid/${name} should pass but reported:\n      ${detail}`);
    continue;
  }
  // A fixture with no records would pass vacuously and prove nothing.
  if (result.samples === 0) failures.push(`valid/${name} contains no samples`);
}

for (const name of logsIn('invalid')) {
  checked += 1;
  const path = join(fixtures, 'invalid', name);
  const expectedPath = path.replace(/\.ndjson$/, '.expected');
  let expected;
  try {
    expected = readFileSync(expectedPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    failures.push(`invalid/${name} has no .expected file naming its error codes`);
    continue;
  }
  if (expected.length === 0) {
    failures.push(`invalid/${name} has an empty .expected file`);
    continue;
  }

  const result = validateLocationLog(readFileSync(path, 'utf8'));
  if (result.ok) {
    failures.push(`invalid/${name} should fail but passed`);
    continue;
  }
  const reported = new Set(
    result.findings.filter((finding) => finding.severity === 'error').map((f) => f.code),
  );
  const missing = expected.filter((code) => !reported.has(code));
  if (missing.length > 0) {
    failures.push(
      `invalid/${name} missing expected error code(s) ${missing.join(', ')}; ` +
        `reported ${[...reported].join(', ') || 'none'}`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.length} of ${checked} fixture(s) failed:\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`${checked} fixture(s) behaved as specified\n`);
