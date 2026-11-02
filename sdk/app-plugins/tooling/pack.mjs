import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { zipSync } from 'fflate';
import { readAppPluginPackage, MAX_APP_PLUGIN_CONTENT_BYTES, MAX_APP_PLUGIN_FILE_BYTES, MAX_APP_PLUGIN_FILES } from '../dist/package.js';

export async function packDirectory(directory) {
  const root = resolve(directory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Input must be a built directory, not a link.');
  const source = await realpath(root);
  const files = Object.create(null);
  let total = 0;
  let count = 0;
  async function collect(directoryPath, prefix = '') {
    for (const name of (await readdir(directoryPath)).sort()) {
      const path = join(directoryPath, name);
      const packagePath = `${prefix}${name}`;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('Package input cannot contain links.');
      if (stat.isDirectory()) {
        await collect(path, `${packagePath}/`);
        continue;
      }
      if (!stat.isFile()) throw new Error('Package input must contain only regular files.');
      count++;
      total += stat.size;
      if (count > MAX_APP_PLUGIN_FILES || stat.size > MAX_APP_PLUGIN_FILE_BYTES || total > MAX_APP_PLUGIN_CONTENT_BYTES) {
        throw new Error(`Package input allows at most ${MAX_APP_PLUGIN_FILES} files, ${MAX_APP_PLUGIN_FILE_BYTES / 1024 / 1024} MiB per file, and ${MAX_APP_PLUGIN_CONTENT_BYTES / 1024 / 1024} MiB total.`);
      }
      const file = await open(path, 'r');
      try {
        const current = await file.stat();
        if (!current.isFile() || current.size !== stat.size) throw new Error('Package input changed during read.');
        const bytes = Buffer.alloc(stat.size + 1);
        let size = 0;
        while (size < bytes.length) {
          const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size !== stat.size) throw new Error('Package input changed during read.');
        files[packagePath] = bytes.subarray(0, size);
      } finally {
        await file.close();
      }
    }
  }
  await collect(source);
  return readAppPluginPackage(Buffer.from(zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') })));
}

export async function packToFile(directory, output) {
  const source = await realpath(resolve(directory));
  const target = resolve(output);
  const outputRelative = relative(source, target);
  if (outputRelative === '' || (!isAbsolute(outputRelative) && outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`))) {
    throw new Error('Write the ZIP outside the input directory.');
  }
  const contents = await packDirectory(directory);
  await writeFile(target, contents.bytes, { flag: 'wx' });
  return { id: contents.manifest.id, version: contents.manifest.version, digest: contents.digest, bytes: contents.bytes.length, output: target };
}
