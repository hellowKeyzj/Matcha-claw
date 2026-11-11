import type { DesktopApi as UpstreamDesktopApi, OpenDocxResult, OpenFileResult } from '../../genoffice/apps/docs/src/shared/ipc';

export type DocsOpenCandidate = OpenDocxResult | (Omit<OpenFileResult, 'dataUrl'> & { recoveryPending: true });

export type DesktopApi = UpstreamDesktopApi & {
  openExternal(url: string): Promise<void>;
  openDocxFile(file: File): Promise<OpenDocxResult>;
  systemFontFamilies(): Promise<readonly string[]>;
};

export type {
  DocTheme,
  OpenDocxResult,
  OpenFileResult,
  PickImageResult,
  PrintPaper,
  UiTheme
} from '../../genoffice/apps/docs/src/shared/ipc';

export type { AiPanelPrefs } from '../../genoffice/packages/ui/src/ai-panel-prefs';
