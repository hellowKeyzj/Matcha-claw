import { AsyncLocalStorage } from 'node:async_hooks';
import type { Lang } from '../../genoffice/packages/i18n/src';

type Options = Record<string, unknown>;
export interface PdfDialogs {
  directory: string;
  language: Lang;
  showOpenDialog(options: Options): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(options: Options): Promise<{ canceled: boolean; filePath?: string }>;
  showMessageBox(options: Options): Promise<{ response: number; checkboxChecked: boolean }>;
}
const current = new AsyncLocalStorage<PdfDialogs>();
export function withPdfDialogs<T>(dialogs: PdfDialogs, run: () => Promise<T>): Promise<T> { return current.run(dialogs, run); }
function adapter(): PdfDialogs {
  const value = current.getStore();
  if (!value) throw new Error('PDF file interaction has no active editor.');
  return value;
}
export function pdfLanguage(): Lang { return adapter().language; }
export function pdfOutputDirectory(): string { return adapter().directory; }
export function showPdfOpenDialog(_dialog: typeof dialog, _parent: unknown, options: Options, _fallbackDir?: string) {
  return dialog.showOpenDialog(options);
}
export const dialog = {
  showOpenDialog(...args: unknown[]) { return adapter().showOpenDialog(args.at(-1) as Options); },
  showSaveDialog(...args: unknown[]) { return adapter().showSaveDialog(args.at(-1) as Options); },
  showMessageBox(...args: unknown[]) { return adapter().showMessageBox(args.at(-1) as Options); }
};
