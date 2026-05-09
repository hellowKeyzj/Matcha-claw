import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { hostFileReadBinary } from '@/lib/host-api';
import { cn } from '@/lib/utils';

const PDF_MAX_BYTES = 50 * 1024 * 1024;
const PDF_VIEWER_PARAMS = 'toolbar=0&navpanes=0&scrollbar=1&view=FitH&zoom=page-width';

interface PdfViewerProps {
  filePath: string;
  fileName?: string;
  surface?: 'default' | 'workspace';
  className?: string;
}

type PdfLoadState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'tooLarge'; size?: number }
  | { status: 'error'; message: string };

function buildViewerUrl(url: string): string {
  return `${url}#${PDF_VIEWER_PARAMS}`;
}

function decodeBase64ToUint8Array(data: string): Uint8Array {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  const cloned = new Uint8Array(bytes.byteLength);
  cloned.set(bytes);
  return cloned.buffer as ArrayBuffer;
}

export function PdfViewer({
  filePath,
  fileName,
  surface = 'default',
  className,
}: PdfViewerProps) {
  const { t } = useTranslation('chat');
  const [state, setState] = useState<PdfLoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setState({ status: 'loading' });

    void (async () => {
      try {
        const result = await hostFileReadBinary({
          path: filePath,
          maxBytes: PDF_MAX_BYTES,
        });
        if (cancelled) {
          return;
        }
        if (!result.ok || !result.data) {
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
          }
          if (result.error === 'tooLarge') {
            setState({ status: 'tooLarge', size: result.size });
            return;
          }
          setState({ status: 'error', message: String(result.error ?? 'unknown') });
          return;
        }
        const blob = new Blob([toBlobPart(decodeBase64ToUint8Array(result.data))], { type: 'application/pdf' });
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [filePath]);

  if (state.status === 'loading') {
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        <LoadingSpinner />
      </div>
    );
  }

  if (state.status === 'tooLarge') {
    return (
      <div className={cn('flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground', className)}>
        {t('artifacts.previewTooLarge')}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className={cn('flex h-full items-center justify-center px-6 text-center text-sm text-destructive', className)}>
        {t('artifacts.previewLoadFailed', { error: state.message })}
      </div>
    );
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
          src={buildViewerUrl(state.url)}
          className={cn(
            'h-full w-full border-0 bg-white',
            surface === 'workspace' && 'rounded-lg shadow-sm ring-1 ring-black/10 dark:ring-white/10',
          )}
        />
      </div>
    </div>
  );
}
