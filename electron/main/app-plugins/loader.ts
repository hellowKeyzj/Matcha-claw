import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { InstalledAppPlugin } from '../../../src/types/desktop/app-plugin';
import type { PluginLoad } from './protocol';
import type { AppPluginStorage } from './storage';
import { isNativeExecutable } from '../runtime-host-delivery/native-artifact.mjs';

export async function preparePluginBackend(load: PluginLoad): Promise<void> {
  const backend = load.manifest.backend;
  if (backend?.language !== 'rust') return;
  if (backend.platform !== process.platform || backend.arch !== process.arch) throw new Error(`This Rust plugin requires ${backend.platform}-${backend.arch}, not ${process.platform}-${process.arch}.`);
  const executable = join(load.packagePath, backend.entry);
  if (process.platform !== 'win32') await chmod(executable, 0o700);
  if (!isNativeExecutable(executable, backend.platform, backend.arch)) throw new Error('The declared Rust backend is not a native executable for this platform and architecture.');
}

export async function materializePlugin(storage: AppPluginStorage, root: string, plugin: InstalledAppPlugin): Promise<PluginLoad> {
  const contents = await storage.readPackage(plugin.manifest.id, plugin.digest, { operation: 'files' });
  if (JSON.stringify(contents.manifest) !== JSON.stringify(plugin.manifest)) throw new Error('Installed app plugin manifest does not match its package.');
  const parent = join(root, 'runtime');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  // Every execution version starts empty; package validation is the sole ZIP/path authority.
  const packagePath = await mkdtemp(join(parent, `${plugin.manifest.id}-`));
  try {
    for (const [name, bytes] of contents.files) {
      const path = join(packagePath, name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    }
    const storagePath = join(root, 'data', plugin.manifest.id);
    await mkdir(storagePath, { recursive: true, mode: 0o700 });
    const load = { manifest: contents.manifest, digest: contents.digest, packagePath, storagePath };
    await preparePluginBackend(load);
    return load;
  } catch (error) {
    await rm(packagePath, { recursive: true, force: true });
    throw error;
  }
}
