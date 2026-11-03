import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packDirectory } from '../sdk/app-plugins/tooling/pack.mjs';
import { readAppPluginPackage, requireDigest, requireObject, requirePluginId } from '../sdk/app-plugins/dist/package.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function readBundledPluginBuilders() {
  const plugins = JSON.parse(await readFile(join(root, 'apps/bundled.json'), 'utf8'));
  if (!Array.isArray(plugins) || plugins.length > 128) throw new Error('Bundled app plugin source list must be an array of at most 128 entries.');
  const ids = new Set();
  for (const value of plugins) {
    const plugin = requireObject(value, ['id', 'build']);
    requirePluginId(plugin.id);
    if (ids.has(plugin.id)) throw new Error(`Duplicate bundled app plugin identifier: ${plugin.id}.`);
    ids.add(plugin.id);
    if (typeof plugin.build !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(plugin.build)
      || plugin.build.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Bundled app plugin ${plugin.id} build must be a repository-relative module path.`);
    }
  }
  const builders = [];
  for (const { id, build } of plugins) {
    const { buildPlugin, validatePlugin } = await import(pathToFileURL(resolve(root, build)).href);
    if (typeof buildPlugin !== 'function' || (validatePlugin !== undefined && typeof validatePlugin !== 'function')) {
      throw new Error(`Bundled app plugin ${id} must export buildPlugin and an optional validatePlugin function.`);
    }
    builders.push({ id, buildPlugin, validatePlugin });
  }
  return builders;
}

export async function validateBundledAppPlugins(directory, platform, arch) {
  const plugins = await readBundledPluginBuilders();
  const receipts = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
  if (!Array.isArray(receipts) || receipts.length !== plugins.length) throw new Error('Bundled app plugin index must match the source list.');
  const remaining = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  for (const value of receipts) {
    const receipt = requireObject(value, ['id', 'version', 'digest']);
    requirePluginId(receipt.id);
    requireDigest(receipt.digest);
    if (typeof receipt.version !== 'string' || receipt.version.length > 64
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(receipt.version)) {
      throw new Error(`Invalid bundled app plugin version: ${receipt.id}.`);
    }
    const plugin = remaining.get(receipt.id);
    if (!plugin) throw new Error(`Duplicate or unlisted bundled app plugin: ${receipt.id}.`);
    remaining.delete(receipt.id);
    const contents = await readAppPluginPackage(await readFile(join(directory, `${receipt.id}.zip`)), receipt.digest);
    if (contents.manifest.id !== receipt.id || contents.manifest.version !== receipt.version) {
      throw new Error(`Bundled app plugin ${receipt.id} does not match its index receipt.`);
    }
    await plugin.validatePlugin?.(contents, platform, arch);
  }
  return receipts;
}

export async function bundleAppPlugins({ platform = process.platform, arch = process.arch, packager } = {}) {
  if (typeof platform !== 'string' || typeof arch !== 'string' || !/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(arch)) {
    throw new Error('Bundled app plugin platform and architecture must be target identifiers.');
  }
  const plugins = await readBundledPluginBuilders();
  const output = join(root, 'build/app-plugins');
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(join(output, '.bundle-'));
  try {
    const staged = join(work, 'bundle');
    await mkdir(staged);
    const receipts = [];
    for (const plugin of plugins) {
      const directory = await plugin.buildPlugin({ platform, arch, outputDirectory: join(work, 'plugins', plugin.id), packager });
      const contents = await packDirectory(directory);
      if (contents.manifest.id !== plugin.id) throw new Error(`Bundled app plugin ${plugin.id} package declares ${contents.manifest.id}.`);
      await plugin.validatePlugin?.(contents, platform, arch);
      receipts.push({ id: plugin.id, version: contents.manifest.version, digest: contents.digest });
      await writeFile(join(staged, `${plugin.id}.zip`), contents.bytes, { flag: 'wx' });
    }
    await writeFile(join(staged, 'index.json'), `${JSON.stringify(receipts)}\n`, { flag: 'wx' });
    const destination = join(output, `${platform}-${arch}`);
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
    for (const receipt of receipts) {
      console.log(`[app-plugins] Bundled ${receipt.id} ${receipt.version} for ${platform}-${arch}: ${receipt.digest}`);
    }
    return receipts;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const option = process.argv[index];
    if (!['--platform', '--arch'].includes(option) || !process.argv[index + 1]) throw new Error(`Invalid app-plugin bundle argument: ${option}.`);
    options[option.slice(2)] = process.argv[index + 1];
  }
  await bundleAppPlugins(options);
}
