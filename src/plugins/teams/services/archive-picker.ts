import { invokeIpc } from '@/lib/api-client';
import type { LocalPathPickerOptions } from '@/lib/local-path-picker';

export async function pickLocalArchive(options: LocalPathPickerOptions = {}): Promise<string | null> {
  const result = await invokeIpc<{ canceled?: boolean; filePaths?: string[] }>('dialog:open', {
    title: options.title,
    defaultPath: options.defaultPath,
    buttonLabel: options.buttonLabel,
    properties: ['openFile'],
    filters: [
      { name: 'TeamSkill Archives', extensions: ['zip', 'tgz', 'tar', 'gz'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths?.[0] ?? null;
}
