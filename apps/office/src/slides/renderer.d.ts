declare module '@matcha/slides-app' {
  import type { ComponentType } from 'react';
  export const App: ComponentType;
}

declare module '@matcha/slides-preload';

declare module '@matcha/slides-pdf-export' {
  type ExportPdfLink = import('../../genoffice/apps/slides/src/shared/ipc').ExportPdfLink;
  type ExportPdfPage = import('../../genoffice/apps/slides/src/shared/ipc').ExportPdfPage;
  export const PDF_EXPORT_HEIGHT_IN: number;
  export function exportPageWidthIn(widthPx: number, heightPx: number): number;
  export function buildPdfExportHtml(pages: ExportPdfPage[], widthIn: number, heightIn: number, links?: ExportPdfLink[][], fontCss?: string): string;
}

declare module '@matcha/slides-audience' {
  import type { ComponentType } from 'react';
  export const AudienceView: ComponentType;
}
