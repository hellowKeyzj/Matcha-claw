import { join } from 'node:path';
import { requireDigest, requireObject, requirePluginId } from './package';
import { MAX_INSTALLED_APP_PLUGINS, readBoundedFile } from './storage';

export interface BundledAppPlugin {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export async function readBundledAppPlugins(directory: string): Promise<readonly BundledAppPlugin[]> {
  const index: unknown = JSON.parse((await readBoundedFile(join(directory, 'index.json'), MAX_INSTALLED_APP_PLUGINS * 1024)).toString('utf8'));
  if (!Array.isArray(index) || index.length > MAX_INSTALLED_APP_PLUGINS) {
    throw new Error('Bundled app plugin index is invalid.');
  }
  const ids = new Set<string>();
  return index.map((value) => {
    const receipt = requireObject(value, ['id', 'version', 'digest']);
    requirePluginId(receipt.id);
    requireDigest(receipt.digest);
    if (ids.has(receipt.id) || typeof receipt.version !== 'string' || receipt.version.length > 64
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(receipt.version)) {
      throw new Error('Bundled app plugin receipt is invalid.');
    }
    ids.add(receipt.id);
    return { id: receipt.id, version: receipt.version, digest: receipt.digest };
  });
}

export function compareAppPluginVersions(left: string, right: string): number {
  const parts = (version: string) => version.split('+')[0].match(/^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/)!;
  const a = parts(left), b = parts(right);
  for (let index = 1; index <= 3; index++) {
    if (BigInt(a[index]) !== BigInt(b[index])) return BigInt(a[index]) > BigInt(b[index]) ? 1 : -1;
  }
  if (a[4] === b[4]) return 0;
  if (a[4] === undefined || b[4] === undefined) return a[4] === undefined ? 1 : -1;
  const preA = a[4].split('.'), preB = b[4].split('.');
  for (let index = 0; index < Math.max(preA.length, preB.length); index++) {
    const x = preA[index], y = preB[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y);
    if (numericX && numericY) {
      if (BigInt(x) === BigInt(y)) continue;
      return BigInt(x) > BigInt(y) ? 1 : -1;
    }
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
