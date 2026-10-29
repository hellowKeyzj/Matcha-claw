import { invokeIpc } from '@/lib/api-client';
import type { LocalPathPickerOptions } from '@/lib/local-path-picker';

export type LocalSkillImportPayload = Readonly<
  | {
    kind: 'markdown';
    skillKey: string;
    content: string;
  }
  | {
    kind: 'bundle';
    skillKey: string;
    files: Array<Readonly<{ path: string; content: string }>>;
  }
>;

export async function pickLocalSkillSource(options: LocalPathPickerOptions = {}): Promise<string | null> {
  const result = await invokeIpc<{ canceled?: boolean; filePaths?: string[] }>('dialog:open', {
    title: options.title,
    defaultPath: options.defaultPath,
    buttonLabel: options.buttonLabel,
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'Skill Sources', extensions: ['zip', 'md'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths?.[0] ?? null;
}

type LocalSkillImportResponse =
  | { canceled: true }
  | ({ canceled: false } & LocalSkillImportPayload);

export async function readLocalSkillImport(sourcePath?: string): Promise<LocalSkillImportPayload | null> {
  const result = await invokeIpc<LocalSkillImportResponse>('dialog:readSkillImport', sourcePath);
  if (result.canceled) {
    return null;
  }
  return result;
}
