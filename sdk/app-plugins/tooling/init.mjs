import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requirePluginId } from '../dist/package.js';

export async function initProject(directory, { id, name, backend = 'typescript', kind = 'application' } = {}) {
  requirePluginId(id);
  if (!['typescript', 'python', 'rust'].includes(backend) || !['reader', 'connector', 'application'].includes(kind)) throw new Error('Unsupported plugin kind or backend.');
  if (kind !== 'application' && backend !== 'typescript') throw new Error('Readers and connectors do not run Python or Rust backends.');
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).length) throw new Error('Initialize a new, empty project directory.');
  const template = kind === 'application' ? backend : kind;
  await cp(fileURLToPath(new URL(`../templates/${template}/`, import.meta.url)), root, { recursive: true, filter: (path) => !/[/\\](?:target|dist|node_modules|__pycache__)(?:[/\\]|$)/.test(path) });
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  manifest.id = id;
  manifest.name = name || id;
  for (const application of manifest.contributes.applications ?? []) application.name = manifest.name;
  if (backend === 'rust') {
    if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('Rust backend requires a supported platform and architecture.');
    manifest.backend.platform = process.platform;
    manifest.backend.arch = process.arch;
    if (process.platform !== 'win32') {
      manifest.backend.entry = manifest.backend.entry.replace(/\.exe$/, '');
      const configPath = join(root, 'app-plugin.build.json');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.assets = Object.fromEntries(Object.entries(config.assets).map(([target, source]) => [target.replace(/\.exe$/, ''), source.replace(/\.exe$/, '')]));
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
  }
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const sdk = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: id, version: '1.0.0', private: true, type: 'module',
    scripts: { build: 'matcha-app-plugin build', watch: 'matcha-app-plugin watch', dev: 'matcha-app-plugin dev', pack: 'matcha-app-plugin pack dist plugin.matcha.zip', ...(backend === 'typescript' && kind !== 'connector' ? { typecheck: 'tsc --noEmit' } : {}) },
    devDependencies: { [sdk.name]: `^${sdk.version}`, ...(backend === 'typescript' && kind !== 'connector' ? { typescript: '^5.9.3' } : {}) },
  }, null, 2)}\n`);
  return { directory: root, id, backend, kind, next: ['Install the downloaded SDK tarball explicitly with npm install --save-dev <sdk.tgz>; no packages were installed by init.', ...(backend === 'rust' ? ['Run cargo build --release --locked before npm run build.'] : []), 'Run npm run build; use npm run dev -- --connection <connection.json> to upload and open preview, then inspect/act/call and install the latest verified digest.'] };
}
