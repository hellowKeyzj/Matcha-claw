import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bun = resolve(root, 'resources/bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'bun.exe' : 'bun');
await access(bun);
const child = spawn(bun, [resolve(root, 'e2e/scripts/license-setup.ts')], {
  cwd: root,
  env: { ...process.env, E2E_PROFILE: 'licensed', DEBUG: '', PWDEBUG: '' },
  stdio: 'inherit',
});
child.on('error', error => { throw error; });
child.on('exit', (code, signal) => {
  if (signal) throw new Error(`License setup terminated: ${signal}`);
  process.exitCode = code ?? 1;
});
