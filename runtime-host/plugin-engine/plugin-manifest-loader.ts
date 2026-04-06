import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { RuntimeHostPluginManifest } from '../shared/types';
import { resolvePluginId } from './plugin-id';

export interface PluginManifestLoader {
  readonly load: (manifestPath: string) => Promise<RuntimeHostPluginManifest>;
}

export function createPluginManifestLoader(): PluginManifestLoader {
  return {
    async load(manifestPath: string): Promise<RuntimeHostPluginManifest> {
      const raw = await readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      const fallbackId = basename(manifestPath).toLowerCase() === 'package.json'
        ? basename(manifestPath, '.json')
        : basename(manifestPath, '.plugin.json');

      const id = resolvePluginId(parsed.id ?? parsed.name, fallbackId || 'unknown-plugin');
      const name = typeof parsed.name === 'string' && parsed.name.trim().length > 0
        ? parsed.name.trim()
        : id;
      const version = typeof parsed.version === 'string' && parsed.version.trim().length > 0
        ? parsed.version.trim()
        : '0.0.0';
      const category = typeof parsed.category === 'string' && parsed.category.trim().length > 0
        ? parsed.category.trim()
        : 'general';
      const description = typeof parsed.description === 'string' && parsed.description.trim().length > 0
        ? parsed.description.trim()
        : undefined;

      return {
        id,
        name,
        version,
        category,
        ...(description ? { description } : {}),
      };
    },
  };
}
