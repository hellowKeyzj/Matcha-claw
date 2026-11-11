import type { SlidesApi } from '../../genoffice/apps/slides/src/shared/ipc';

declare global {
  interface Window {
    slidesApi: SlidesApi;
  }
}

export {};
