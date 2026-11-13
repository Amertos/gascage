#!/usr/bin/env node
/** Bundles src/core into build/core.mjs so node:test can import it without a loader. */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'build', 'core.mjs');

await mkdir(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src', 'core', 'index.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`core bundle: ${outfile.replace(root + '/', '')} (${bytes} bytes)`);
