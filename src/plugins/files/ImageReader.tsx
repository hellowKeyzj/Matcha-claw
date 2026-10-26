import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StableScrollArea } from '@/components/scroll';
import type { BinaryFileReaderProps } from './extensions';

export function ImageReader({ file, data }: BinaryFileReaderProps) {
  const { t } = useTranslation('chat');
  const [error, setError] = useState<string>();
  const attachImage = useCallback((image: HTMLImageElement | null) => {
    if (!image) return;
    try {
      const url = URL.createObjectURL(new Blob([data], { type: file.mimeType }));
      image.src = url;
      return () => URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [data, file.mimeType]);

  if (error) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{t('artifacts.previewLoadFailed', { error })}</div>;
  }

  return (
    <StableScrollArea className="flex h-full min-h-0 items-center justify-center overflow-auto bg-[hsl(var(--muted)/0.3)] p-4">
      <img
        ref={attachImage}
        alt={file.fileName}
        className="max-h-full max-w-full rounded-lg border border-border/45 bg-background shadow-sm"
      />
    </StableScrollArea>
  );
}
