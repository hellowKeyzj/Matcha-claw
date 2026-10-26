import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const PDF_VIEWER_PARAMS = 'toolbar=0&navpanes=0&scrollbar=1&view=FitH&zoom=page-width';

interface PdfViewerProps {
  data: ArrayBuffer;
  fileName?: string;
  surface?: 'default' | 'workspace';
  className?: string;
}

export function PdfViewer({
  data,
  fileName,
  surface = 'default',
  className,
}: PdfViewerProps) {
  const { t } = useTranslation('chat');
  const [error, setError] = useState<string>();
  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
    if (!frame) return;
    try {
      const objectUrl = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
      frame.src = `${objectUrl}#${PDF_VIEWER_PARAMS}`;
      return () => URL.revokeObjectURL(objectUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [data]);

  const loadError = data.byteLength === 0 ? 'unknown' : error;
  if (loadError) {
    return <div className={cn('flex h-full items-center justify-center px-6 text-center text-sm text-destructive', className)}>{t('artifacts.previewLoadFailed', { error: loadError })}</div>;
  }

  return (
    <div
      data-testid="pdf-viewer"
      className={cn(
        'h-full min-h-0 overflow-hidden bg-white',
        surface === 'workspace' && 'overflow-auto bg-[hsl(var(--muted)/0.35)] p-4 dark:bg-background',
        className,
      )}
    >
      <div
        className={cn(
          'h-full w-full',
          surface === 'workspace' && 'mx-auto max-w-[820px]',
        )}
        style={surface === 'workspace' ? { aspectRatio: '1 / 1.414' } : undefined}
      >
        <iframe
          title={fileName || t('artifacts.previewPdfTitle')}
          ref={attachFrame}
          className={cn(
            'h-full w-full border-0 bg-white',
            surface === 'workspace' && 'rounded-lg shadow-sm ring-1 ring-black/10 dark:ring-white/10',
          )}
        />
      </div>
    </div>
  );
}
