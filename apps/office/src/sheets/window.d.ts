import type { DesktopApi } from '../../genoffice/apps/sheets/src/shared/desktop-api';

declare global {
  interface Window {
    readonly desktopApi: DesktopApi;
    readonly nativeSpell?: {
      readonly isWordMisspelled: (word: string) => boolean;
      readonly getWordSuggestions: (word: string) => string[];
      readonly checkWord?: (word: string) => Promise<{ misspelled: boolean; suggestions: string[] }>;
      readonly learnWord?: (word: string) => Promise<boolean>;
    };
  }
}

export {};
