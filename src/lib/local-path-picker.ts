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
