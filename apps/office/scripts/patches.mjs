import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);

export async function preparePatches(genoffice, jsdom) {
  const targets = [
    {
      source: join(genoffice, 'apps', 'sheets', 'src', 'main', 'sheets-main.ts'),
      manifest: join(genoffice, 'apps', 'sheets', 'package.json'),
      name: '@genoffice/sheets',
      version: '0.1.0',
      sha256: 'b8cf3d7c6af08ffc1269ffeb485fe1edaac78760dcf36c137d9bc1c912431e3b',
      relative: 'genoffice/apps/sheets/src/main/sheets-main.ts',
      patch: 'genoffice/sheets-save-runtime.patch',
      loader: 'ts'
    },
    {
      source: join(jsdom, 'lib', 'jsdom', 'living', 'helpers', 'style-rules.js'),
      manifest: join(jsdom, 'package.json'),
      name: 'jsdom',
      version: '28.1.0',
      sha256: '8c52f4df4f291fa119ff71de36ecd7a5cd91058fe392ac3885ea19ce281e6789',
      relative: 'jsdom/lib/jsdom/living/helpers/style-rules.js',
      patch: 'jsdom/default-stylesheet.patch',
      loader: 'js'
    }
  ];
  const require = createRequire(import.meta.url);
  const pptParser = require.resolve('ppt-to-text');
  targets.push({
    source: pptParser,
    manifest: join(dirname(pptParser), 'package.json'),
    name: 'ppt-to-text',
    version: '1.0.1',
    sha256: '49644dc91e15672da5c845f2231e01591037608536add990e2aff328425f1269',
    relative: 'ppt-to-text/ppt.js',
    patch: 'ppt-to-text/preinitialized-decoder.patch',
    loader: 'js'
  });
  const sharpManifest = require.resolve('sharp/package.json');
  const sharpRoot = dirname(sharpManifest);
  for (const [file, sha256] of [
    ['sharp.js', '59e9436f1c62a58b8781acb3803e55114bada9984cc7c39b9291769155811cd3'],
    ['utility.js', 'ada1854f397f54ee09286094a4f4cd9a4d4af9f4ddbaae3b4f477edbd8c1fd14'],
    ['libvips.js', 'ae8cbc8008bf88f5100ca56729ed43d45cd88316e030dc2eed62e142f657cd79']
  ]) {
    targets.push({
      source: join(sharpRoot, 'lib', file),
      manifest: sharpManifest,
      name: 'sharp',
      version: '0.34.5',
      sha256,
      relative: `sharp/lib/${file}`,
      patch: `sharp/${file}.patch`,
      loader: 'js'
    });
  }
  const additions = JSON.parse(await readFile(join(root, 'patches', 'genoffice', 'manifest.json'), 'utf8'));
  targets.push(...additions.map((target) => ({
    ...target,
    source: join(genoffice, target.source),
    manifest: join(genoffice, target.manifest)
  })));
  const overlay = await mkdtemp(join(tmpdir(), 'matcha-office-patches-'));
  const cleanup = () => rm(overlay, { recursive: true, force: true });
  try {
    const patched = new Map();
    for (const target of targets) {
      const manifest = JSON.parse(await readFile(target.manifest, 'utf8'));
      if (manifest.name !== target.name || manifest.version !== target.version) {
        throw new Error(`Office patch requires ${target.name}@${target.version}: ${target.manifest}`);
      }
      const contents = await readFile(target.source);
      if (createHash('sha256').update(contents).digest('hex') !== target.sha256) {
        throw new Error(`Office patch source mismatch (dirty or unsupported upstream): ${target.source}`);
      }
      const path = join(overlay, target.relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
      const patch = join(root, 'patches', target.patch);
      await run('git', ['apply', '--check', '--whitespace=error-all', patch], { cwd: overlay });
      await run('git', ['apply', '--whitespace=error-all', patch], { cwd: overlay });
      patched.set(resolve(target.source), { contents: await readFile(path, 'utf8'), loader: target.loader });
    }
    return {
      cleanup,
      readFile: (path) => patched.get(resolve(path))?.contents,
      plugin: {
        name: 'office-source-patches',
        setup(builder) {
          // Load patched bytes at the original path: aliases share one module/session Map,
          // and relative imports and dependency/license resolution keep their upstream base.
          builder.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: 'file' }, (args) => {
            const target = patched.get(resolve(args.path));
            return target && { ...target, resolveDir: dirname(args.path) };
          });
        }
      }
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
