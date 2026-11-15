import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BinaryFileReaderProps } from './extensions';

export function MediaReader({ file, data }: BinaryFileReaderProps) {
  const { t } = useTranslation('chat');
  const [failed, setFailed] = useState(false);
  const attachMedia = useCallback((element: HTMLMediaElement | null) => {
    if (!element) return;
    const url = URL.createObjectURL(new Blob([data], { type: file.mimeType }));
    element.src = url;
    return () => { element.pause(); element.removeAttribute('src'); element.load(); URL.revokeObjectURL(url); };
  }, [data, file.mimeType]);

  if (failed || data.byteLength === 0) {
    return <div role="status" className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{t('artifacts.previewLoadFailed', { error: t('media.previewUnavailable') })}</div>;
  }

  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-[hsl(var(--muted)/0.3)] p-4">
      {file.contentType === 'audio'
        ? <audio ref={attachMedia} controls preload="metadata" aria-label={file.fileName} className="w-full max-w-xl" onError={() => setFailed(true)} />
        : <video ref={attachMedia} controls preload="metadata" aria-label={file.fileName} className="max-h-full max-w-full rounded-lg" onError={() => setFailed(true)} />}
    </div>
  );
}
