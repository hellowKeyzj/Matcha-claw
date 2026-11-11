import type { MarkdownApi } from '../../genoffice/apps/markdown/src/shared/ipc';
declare global {
  interface Window { markdownApi: MarkdownApi; }
}
