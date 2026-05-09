import { invokeIpc } from '@/lib/api-client';

export const DIRECT_OPEN_FALLBACK_EXTS = new Set(['.pdf', '.xls', '.xlsx']);
export const DIRECT_OPEN_FALLBACK_MIN_BYTES = 2 * 1024 * 1024;

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')} ${units[exponent]}`;
}

export function isDirectOpenFallbackExt(ext?: string | null): boolean {
  return !!ext && DIRECT_OPEN_FALLBACK_EXTS.has(ext.toLowerCase());
}

export function shouldOfferDirectOpenFallback(ext?: string | null, size?: number): boolean {
  return isDirectOpenFallbackExt(ext) && typeof size === 'number' && size > DIRECT_OPEN_FALLBACK_MIN_BYTES;
}

export async function openArtifactPathExternally(filePath: string): Promise<string | null> {
  const result = await invokeIpc<unknown>('shell:openPath', filePath);
  return typeof result === 'string' && result.trim() ? result : null;
}

export async function revealArtifactPathInFileManager(filePath: string): Promise<boolean> {
  const result = await invokeIpc<unknown>('shell:showItemInFolder', filePath);
  if (!result || typeof result !== 'object') {
    return false;
  }
  return (result as { success?: boolean }).success === true;
}

export async function confirmAndOpenArtifactPath(params: {
  filePath: string;
  fileName: string;
  size?: number;
  t: (key: string, options?: Record<string, unknown>) => string;
}): Promise<boolean> {
  const { filePath, fileName, size, t } = params;
  const detail = [
    t('artifacts.confirmOpenDetail'),
    typeof size === 'number'
      ? t('artifacts.confirmOpenSize', { size: formatFileSize(size) })
      : null,
    filePath,
  ].filter(Boolean).join('\n');
  const result = await invokeIpc<{ response?: number }>('dialog:message', {
    type: 'question',
    buttons: [
      t('artifacts.confirmOpenCancel'),
      t('artifacts.openDirectly'),
    ],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: t('artifacts.confirmOpenTitle'),
    message: t('artifacts.confirmOpenMessage', { fileName }),
    detail,
  });
  if (result?.response !== 1) {
    return false;
  }
  const error = await openArtifactPathExternally(filePath);
  if (error) {
    throw new Error(error);
  }
  return true;
}
