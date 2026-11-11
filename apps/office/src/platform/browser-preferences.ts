import type { AppToolResult } from '@matcha/app-plugins-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../genoffice/packages/electron-utils/src/atomic-write';
import { OfficeError, errorMessage } from '../errors';

const EDITORS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'] as const;
type Editor = typeof EDITORS[number];
type Preferences = Partial<Record<Editor, Record<string, string>>>;
export type BrowserStorageChange = { key: string; value: string | null } | { key: null; value: null };
const TOOL_EDITORS = new Map(EDITORS.map((editor) => [`office_${editor}_ipc`, editor]));

export function createBrowserPreferences(storagePath: string) {
  const path = join(storagePath, 'browser-preferences.json');

  function read(): Preferences {
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const stored: unknown = JSON.parse(source);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Invalid Office browser preferences.');
    for (const [editor, values] of Object.entries(stored)) {
      if (!EDITORS.includes(editor as Editor) || !values || typeof values !== 'object' || Array.isArray(values)
        || Object.values(values).some((value) => typeof value !== 'string')) throw new Error('Invalid Office browser preferences.');
    }
    return stored as Preferences;
  }

  return (toolName: string, input: Record<string, unknown>): AppToolResult | undefined => {
    const editor = TOOL_EDITORS.get(toolName);
    if (!editor || (input.channel !== 'office:browser-storage:get' && input.channel !== 'office:browser-storage:set')) return undefined;
    try {
      const args = input.arguments;
      if (!Array.isArray(args)) throw new OfficeError('invalid_request', 'Browser storage arguments must be an array.');
      let result: Record<string, string> | null;
      if (input.channel === 'office:browser-storage:get') {
        if (args.length) throw new OfficeError('invalid_request', 'Browser storage get requires no arguments.');
        result = read()[editor] ?? {};
      } else {
        const change = args[0] as BrowserStorageChange | undefined;
        if (args.length !== 1 || !change || typeof change !== 'object' || Array.isArray(change)
          || (typeof change.key !== 'string' && change.key !== null)
          || (typeof change.value !== 'string' && change.value !== null)
          || (change.key === null && change.value !== null)) {
          throw new OfficeError('invalid_request', 'Browser storage set requires { key: string, value: string | null }; clear requires { key: null, value: null }.');
        }
        const stored = read();
        const values = new Map(Object.entries(stored[editor] ?? {}));
        if (change.key === null) values.clear();
        else if (change.value === null) values.delete(change.key);
        else values.set(change.key, change.value);
        writeJsonAtomic(path, { ...stored, [editor]: Object.fromEntries(values) });
        result = null;
      }
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { result } };
    } catch (error) {
      const message = errorMessage(error);
      return {
        content: [{ type: 'text', text: message }], isError: true,
        structuredContent: { code: error instanceof OfficeError ? error.code : 'browser_storage_failed', error: message }
      };
    }
  };
}
