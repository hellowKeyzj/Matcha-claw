import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tar from 'tar';

const root = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(root, '.package-'));
try {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const packageRoot = join(temporary, 'package');
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: manifest.name, version: manifest.version, description: manifest.description,
    type: manifest.type, main: manifest.main, module: manifest.module, types: manifest.types, engines: manifest.engines, bin: manifest.bin, exports: manifest.exports,
    files: manifest.files, dependencies: manifest.dependencies,
  }, null, 2)}\n`);
  for (const name of ['dist', 'tooling', 'templates']) {
    await cp(join(root, name), join(packageRoot, name), { recursive: true,
      filter: (path) => !path.split(/[\\/]/).some((part) => ['node_modules', 'target', '__pycache__'].includes(part) || part.startsWith('.matcha-'))
        && !/[/\\]templates[/\\][^/\\]+[/\\]dist(?:[/\\]|$)/.test(path),
    });
  }
  await cp(join(root, 'README.md'), join(packageRoot, 'README.md'));
  for (const backend of ['typescript', 'python', 'rust', 'reader', 'connector']) {
    if (!(await lstat(join(packageRoot, 'templates', backend, 'manifest.json'))).isFile()) throw new Error(`Missing SDK template: ${backend}`);
  }
  const files = [];
  async function collect(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const entry = `${prefix}/${name}`;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('SDK distribution cannot contain symbolic links.');
      if (stat.isDirectory()) await collect(path, entry);
      else if (stat.isFile()) files.push(entry);
      else throw new Error('SDK distribution must contain regular files only.');
    }
  }
  await collect(packageRoot, 'package');
  const name = `matcha-app-plugins-sdk-${manifest.version}.tgz`;
  const output = join(temporary, name);
  await tar.c({ cwd: temporary, file: output, gzip: true, portable: true, mtime: new Date('2026-01-01T00:00:00Z'), noMtime: false }, files);
  await rename(output, join(root, name));
  console.log(`Packed sdk/app-plugins/${name} (${files.length} files).`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
