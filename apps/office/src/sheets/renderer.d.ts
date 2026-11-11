declare module '@matcha/sheets-app' {
  import type { ComponentType } from 'react';
  export const App: ComponentType<{ queuedWorkbookAtBoot: boolean }>;
}

declare module '@matcha/sheets-fonts' {
  export function installCanvasFontFallback(): void;
  export function registerTextDingbatsFace(): Promise<unknown>;
  export function untilCellFontsLoaded(loads: Promise<unknown>): Promise<void>;
}

declare module '@matcha/sheets-locale' {
  import type { ComponentType, ReactNode } from 'react';
  export const LocaleProvider: ComponentType<{ initial: string; children?: ReactNode }>;
  export function setModuleLang(lang: string): void;
}
