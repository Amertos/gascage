#!/usr/bin/env node
/**
 * Test runner. Discovers the suites itself instead of relying on shell globbing,
 * which differs between cmd.exe, PowerShell and Git Bash on Windows.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = join(root, 'tests');

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => join('tests', f));

if (files.length === 0) {
  console.error('no test files found in tests/');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: root,
});

process.exit(result.status ?? 1);
