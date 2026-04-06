#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const tsconfigPath = resolve(rootDir, 'tsconfig.runtime-host-process.json');
const runtimeHostDir = resolve(rootDir, 'runtime-host');
const buildDir = resolve(runtimeHostDir, 'build');
const legacyBuildDir = resolve(runtimeHostDir, 'api', 'build');
const wrapperEntry = resolve(runtimeHostDir, 'host-process.cjs');

rmSync(buildDir, { recursive: true, force: true });
rmSync(legacyBuildDir, { recursive: true, force: true });

const isWindows = process.platform === 'win32';
const result = spawnSync('pnpm', ['exec', 'tsc', '-p', tsconfigPath], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: isWindows,
});

if (result.error) {
  console.error('[build-runtime-host-process] failed to spawn tsc:', result.error);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

mkdirSync(runtimeHostDir, { recursive: true });
mkdirSync(buildDir, { recursive: true });
writeFileSync(
  resolve(buildDir, 'package.json'),
  '{\n  "type": "commonjs"\n}\n',
  'utf8',
);
writeFileSync(
  wrapperEntry,
  "'use strict';\nrequire('./build/main.js');\n",
  'utf8',
);

console.log('[build-runtime-host-process] built runtime-host/build and refreshed runtime-host/host-process.cjs');
