import { lstat, mkdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'e2e', '.cache', 'app');
const require = createRequire(join(root, 'package.json'));
await mkdir(output, { recursive: true });
const { name, version } = require('./package.json');
// Keep the production Main/preload CommonJS boundary inside this ESM workspace.
await writeFile(join(output, 'package.json'), JSON.stringify({ name, version, private: true, type: 'commonjs' }, null, 2));
for (const name of ['resources', 'node_modules']) {
  const link = join(output, name);
  const target = join(root, name);
  const existing = await lstat(link).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing) {
    if (!existing.isSymbolicLink() || resolve(dirname(link), await readlink(link)) !== target) {
      throw new Error(`Refusing to replace unexpected E2E build resource: ${link}`);
    }
  } else {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
const child = spawn(process.execPath, [
  '--max-old-space-size=4096',
  join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
  'build', '--mode', 'e2e',
], { cwd: root, stdio: 'inherit' });
child.on('error', error => { throw error; });
child.on('exit', (code, signal) => {
  if (signal) throw new Error(`E2E application build terminated: ${signal}`);
  process.exitCode = code ?? 1;
});
