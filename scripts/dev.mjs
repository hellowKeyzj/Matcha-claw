#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const devElectronDist = join(projectRoot, '.cache', 'matchaclaw', 'dev-electron-icon', 'dist');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: options.env ?? process.env,
    shell: true,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('node', ['scripts/build-runtime-host-native.mjs', '--platform', 'win32', '--arch', 'x64']);
run('node', ['scripts/patch-dev-electron-icon.mjs']);
run('vite', [], {
  env: process.platform === 'win32'
    ? { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: devElectronDist }
    : process.env,
});
