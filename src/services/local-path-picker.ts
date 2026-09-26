import { invokeIpc } from '@/lib/api-client';

export interface LocalPathPickerOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
}

interface LocalPathPickerResult {
  canceled?: boolean;
  filePaths?: string[];
}

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

function readSelectedPath(result: LocalPathPickerResult): string | null {
  if (result.canceled || !result.filePaths?.length) {
    return null;
  }
  return result.filePaths[0] ?? null;
}

export async function pickLocalDirectory(options: LocalPathPickerOptions = {}): Promise<string | null> {
  return readSelectedPath(await invokeIpc<LocalPathPickerResult>('dialog:open', {
    title: options.title,
    defaultPath: options.defaultPath,
    buttonLabel: options.buttonLabel,
    properties: ['openDirectory'],
  }));
}

export async function pickLocalFile(options: LocalPathPickerOptions = {}): Promise<string | null> {
  return readSelectedPath(await invokeIpc<LocalPathPickerResult>('dialog:open', {
    title: options.title,
    defaultPath: options.defaultPath,
    buttonLabel: options.buttonLabel,
    properties: ['openFile'],
  }));
}

export async function pickLocalArchive(options: LocalPathPickerOptions = {}): Promise<string | null> {
  return readSelectedPath(await invokeIpc<LocalPathPickerResult>('dialog:open', {
    title: options.title,
    defaultPath: options.defaultPath,
    buttonLabel: options.buttonLabel,
    properties: ['openFile'],
    filters: [
      { name: 'TeamSkill Archives', extensions: ['zip', 'tgz', 'tar', 'gz'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  }));
}

export async function pickLocalSkillSource(options: LocalPathPickerOptions = {}): Promise<string | null> {
  return readSelectedPath(await invokeIpc<LocalPathPickerResult>('dialog:open', {
    title: options.title,
    defaultPath: options.defaultPath,
    buttonLabel: options.buttonLabel,
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'Skill Sources', extensions: ['zip', 'md'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  }));
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
