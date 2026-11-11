import type { AppPluginContext } from '@matcha/app-plugins-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeAuthorName, systemAuthorName } from '../../genoffice/packages/electron-utils/src/author-name';
import { writeJsonAtomic } from '../../genoffice/packages/electron-utils/src/atomic-write';
import { OfficeError } from '../errors';
import type { OfficeSettings } from './client';

export function createOfficeSettings(context: AppPluginContext): { call(channel: string, args: unknown[]): unknown } {
  const path = join(context.storagePath, 'app-settings.json');

  function read(): Record<string, unknown> {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    } catch {
      // Upstream treats missing or corrupt app-settings.json as empty settings.
    }
    return {};
  }

  function settings(raw: Record<string, unknown>): OfficeSettings {
    const value = sanitizeAuthorName(raw.authorName);
    const fallback = systemAuthorName();
    return {
      documentTheme: raw.documentTheme === 'light' || raw.documentTheme === 'dark' ? raw.documentTheme : 'follow',
      autoSaveDefault: {
        on: raw.autoSaveDefault === true,
        updatedAt: typeof raw.autoSaveDefaultUpdatedAt === 'number' && raw.autoSaveDefaultUpdatedAt > 0 ? raw.autoSaveDefaultUpdatedAt : 0
      },
      authorName: value || fallback,
      authorNameSetting: { value, fallback }
    };
  }

  return {
    call(channel, args) {
      if (channel !== 'office:settings:get' && channel !== 'office:settings:set') throw new OfficeError('invalid_channel', 'Unsupported Office settings channel.');
      if (!Array.isArray(args)) throw new OfficeError('invalid_input', 'Office settings arguments must be an array.');
      if (channel === 'office:settings:get') {
        if (args.length) throw new OfficeError('invalid_input', 'Getting Office settings takes no arguments.');
        return settings(read());
      }
      const input = args[0];
      if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input)) throw new OfficeError('invalid_input', 'An Office settings patch is required.');
      const patch = input as Record<string, unknown>;
      for (const key of Object.keys(patch)) {
        const value = patch[key];
        if (key === 'documentTheme' ? value !== 'light' && value !== 'dark' && value !== 'follow'
          : key === 'autoSaveDefault' ? typeof value !== 'boolean'
          : key === 'authorName' ? typeof value !== 'string' : true) {
          throw new OfficeError('invalid_input', `Invalid Office setting: ${key}.`);
        }
      }
      const raw = read();
      const previous = settings(raw);
      const updates: Record<string, unknown> = {};
      if (Object.hasOwn(patch, 'documentTheme') && patch.documentTheme !== previous.documentTheme) updates.documentTheme = patch.documentTheme;
      if (Object.hasOwn(patch, 'authorName')) {
        const value = sanitizeAuthorName(patch.authorName);
        if (value !== previous.authorNameSetting.value) updates.authorName = value;
      }
      if (Object.hasOwn(patch, 'autoSaveDefault') && patch.autoSaveDefault !== previous.autoSaveDefault.on) {
        updates.autoSaveDefault = patch.autoSaveDefault;
        updates.autoSaveDefaultUpdatedAt = Date.now();
      }
      if (!Object.keys(updates).length) return previous;
      const next = { ...raw, ...updates };
      writeJsonAtomic(path, next);
      const current = settings(next);
      try { context.publish('office.settings.changed', current); }
      catch (error) { context.log.error(`Office settings were saved, but notification failed: ${String(error)}`); }
      return current;
    }
  };
}
