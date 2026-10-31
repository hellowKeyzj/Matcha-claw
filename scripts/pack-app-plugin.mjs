import { lstat, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { zipSync } from 'fflate';
import ts from 'typescript';

const usage = 'Usage: node scripts/pack-app-plugin.mjs <built-directory> <output.zip>';

async function main() {
  const [directory, output, ...extra] = process.argv.slice(2);
  if (directory === '--help' && !output) {
    console.log(usage);
    return;
  }
  if (!directory || !output || extra.length) throw new Error(usage);

  // Only this fixed, repository-owned validator is compiled. Input files are never imported or executed.
  const validatorUrl = new URL('../electron/main/app-plugins/package.ts', import.meta.url);
  const compiled = ts.transpileModule(await readFile(validatorUrl, 'utf8'), {
    fileName: fileURLToPath(validatorUrl),
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const validator = {};
  compileFunction(compiled.outputText, ['require', 'exports'], { filename: fileURLToPath(validatorUrl) })(createRequire(import.meta.url), validator);
  const { readAppPluginPackage, MAX_APP_PLUGIN_CONTENT_BYTES, MAX_APP_PLUGIN_FILE_BYTES, MAX_APP_PLUGIN_FILES } = validator;

  const root = resolve(directory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Input must be a built directory, not a link.');
  const source = await realpath(root);
  const target = resolve(output);
  const outputRelative = relative(source, target);
  if (outputRelative === '' || (!isAbsolute(outputRelative) && outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`))) {
    throw new Error('Write the ZIP outside the input directory.');
  }

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
  const contents = await readAppPluginPackage(Buffer.from(zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') })));
  await writeFile(target, contents.bytes, { flag: 'wx' });
  console.log(JSON.stringify({ id: contents.manifest.id, version: contents.manifest.version, digest: contents.digest, bytes: contents.bytes.length, output: target }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
