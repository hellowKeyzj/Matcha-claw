import type { AppWebviewApi } from './api.js';

export type AppReaderInput = { readonly fileName: string; readonly extension: string; readonly mimeType: string }
  & ({ readonly source: 'text'; readonly text: string } | { readonly source: 'binary'; readonly data: ArrayBuffer });

export interface AppReaderApi {
  onInput(listener: (input: AppReaderInput) => void): () => void;
  ready(): void;
  error(message: string): void;
}

declare global {
  interface Window {
    readonly matchaApp?: AppWebviewApi;
    readonly matchaReader?: AppReaderApi;
  }
}
