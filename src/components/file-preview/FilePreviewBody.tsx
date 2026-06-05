import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { CsvPreview } from '@/pages/Chat/components/CsvPreview';
import { buildLineDiff } from '@/lib/line-diff';
import {
  hostFileReadBinary,
  hostFileReadText,
  type ReadTextFileResult,
} from '@/lib/host-api';
import {
  supportsInlineDiff,
} from '@/lib/generated-files';
import { cn } from '@/lib/utils';
import { MonacoDiffViewer } from './MonacoDiffViewer';
import { MonacoViewer } from './MonacoViewer';
import { MarkdownPreview } from './MarkdownPreview';
import { HtmlPreview } from './HtmlPreview';
import { PdfViewer } from './PdfViewer';
import { SheetViewer } from './SheetViewer';
import type { ArtifactPreviewTarget } from './types';
import {
  confirmAndOpenArtifactPath,
  openArtifactPathExternally,
  revealArtifactPathInFileManager,
  shouldOfferDirectOpenFallback,
} from './open-file-utils';

export type FilePreviewMode = 'preview' | 'diff';
const INLINE_BINARY_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

interface FilePreviewBodyProps {
  file: ArtifactPreviewTarget;
  mode: FilePreviewMode;
  className?: string;
  showHeader?: boolean;
  headerAccessory?: ReactNode;
  headerTrailingAccessory?: ReactNode;
  runtimeAddress?: ArtifactPreviewTarget['runtimeAddress'];
}

type TextPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'tooLarge' }
  | { status: 'binary' }
  | { status: 'error'; message: string };

type BinaryPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; objectUrl: string }
  | { status: 'tooLarge' }
  | { status: 'error'; message: string };

function decodeBase64ToUint8Array(data: string): Uint8Array {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toBlobObjectUrl(data: string, mimeType: string): string {
  const bytes = decodeBase64ToUint8Array(data);
  const cloned = new Uint8Array(bytes.byteLength);
  cloned.set(bytes);
  return URL.createObjectURL(new Blob([cloned.buffer as ArrayBuffer], { type: mimeType }));
}

function renderPlainDiff(file: ArtifactPreviewTarget) {
  const diffRows = buildLineDiff(file.baseline ?? '', file.content ?? '');
  return (
    <div className="overflow-auto rounded-[18px] border border-border/45 bg-background/68 p-3 shadow-sm backdrop-blur-sm">
      <pre className="text-[12px] leading-6 text-foreground/90">
        {diffRows.map((row, index) => (
          <div
            key={`${row.type}:${index}`}
            className={cn(
              row.type === 'add' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
              row.type === 'remove' && 'bg-destructive/10 text-destructive',
            )}
          >
            <span className="mr-2 inline-block w-4 text-center">
              {row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' '}
            </span>
            {row.value}
          </div>
        ))}
      </pre>
    </div>
  );
}

function PreviewFallbackAction({
  label,
  description,
  openLabel,
  revealLabel,
  onOpen,
  onReveal,
  className,
}: {
  label: string;
  description: string;
  openLabel: string;
  revealLabel: string;
  onOpen: () => void;
  onReveal: () => void;
  className?: string;
}) {
  return (
    <div className={cn('flex h-full items-center justify-center px-6 py-8', className)}>
      <div className="max-w-md rounded-[18px] border border-border/45 bg-background/68 p-5 text-center shadow-sm backdrop-blur-sm">
        <p className="text-sm text-foreground">{label}</p>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button type="button" size="sm" className="gap-1.5" onClick={onOpen}>
            <ExternalLink className="h-3.5 w-3.5" />
            {openLabel}
          </Button>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onReveal}>
            <FolderOpen className="h-3.5 w-3.5" />
            {revealLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function FilePreviewBody({
  file,
  mode,
  className,
  showHeader = true,
  headerAccessory,
  headerTrailingAccessory,
  runtimeAddress,
}: FilePreviewBodyProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [textState, setTextState] = useState<TextPreviewState>({ status: 'idle' });
  const [binaryState, setBinaryState] = useState<BinaryPreviewState>({ status: 'idle' });
  const [pathCopied, setPathCopied] = useState(false);
  const previewInstanceKey = `${file.filePath || file.fileName}:${mode}`;
  const shouldUseInlineSnapshot = file.sourceTool !== 'write' && !!file.content;
  const fileRuntimeAddress = runtimeAddress ?? file.runtimeAddress;
  const canDirectOpen = !!file.filePath;
  const fileTooLargeForPreview = typeof file.fileSize === 'number' && file.fileSize > INLINE_BINARY_PREVIEW_MAX_BYTES;
  const shouldConfirmDirectOpen = shouldOfferDirectOpenFallback(file.ext, file.fileSize);
  const openInSystemApp = useCallback(async () => {
    if (!file.filePath) {
      return;
    }
    try {
      if (shouldConfirmDirectOpen) {
        await confirmAndOpenArtifactPath({
          filePath: file.filePath,
          fileName: file.fileName,
          size: file.fileSize,
          t,
        });
        return;
      }
      const error = await openArtifactPathExternally(file.filePath);
      if (error) {
        throw new Error(error);
      }
    } catch (error) {
      toast.error(t('artifacts.openFailed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [file.fileName, file.filePath, file.fileSize, shouldConfirmDirectOpen, t]);
  const revealInFileManager = useCallback(async () => {
    if (!file.filePath) {
      return;
    }
    const success = await revealArtifactPathInFileManager(file.filePath);
    if (!success) {
      toast.error(t('artifacts.revealFailed'));
    }
  }, [file.filePath, t]);

  useEffect(() => {
    setPathCopied(false);
  }, [file.filePath]);
  const copyFilePath = useCallback(async () => {
    if (!file.filePath) {
      return;
    }
    try {
      await navigator.clipboard.writeText(file.filePath);
      setPathCopied(true);
      toast.success(t('artifacts.copyPathCopied'));
      window.setTimeout(() => setPathCopied(false), 1500);
    } catch (error) {
      toast.error(t('artifacts.copyPathFailed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [file.filePath, t]);

  const shouldLoadTextPreview = useMemo(() => {
    if (file.contentType === 'code' || file.contentType === 'text' || file.contentType === 'markdown' || file.contentType === 'html') {
      return mode === 'preview' && !shouldUseInlineSnapshot;
    }
    if (file.contentType === 'sheet' && file.ext === '.csv') {
      return mode === 'preview' && !shouldUseInlineSnapshot;
    }
    return false;
  }, [file.contentType, file.ext, mode, shouldUseInlineSnapshot]);

  useEffect(() => {
    if (!shouldLoadTextPreview) {
      setTextState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    setTextState({ status: 'loading' });

    void (async () => {
      try {
        if (!fileRuntimeAddress) {
          throw new Error('RuntimeAddress is required');
        }
        const result: ReadTextFileResult = await hostFileReadText({
          path: file.filePath,
          runtimeAddress: fileRuntimeAddress,
        });
        if (cancelled) {
          return;
        }
        if (!result.ok || typeof result.content !== 'string') {
          if (result.error === 'tooLarge') {
            setTextState({ status: 'tooLarge' });
            return;
          }
          if (result.error === 'binary') {
            setTextState({ status: 'binary' });
            return;
          }
          setTextState({ status: 'error', message: String(result.error ?? 'unknown') });
          return;
        }
        setTextState({ status: 'ready', content: result.content });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setTextState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file.filePath, fileRuntimeAddress, shouldLoadTextPreview]);

  const shouldLoadBinaryPreview = useMemo(() => (
    mode === 'preview' && file.contentType === 'image'
  ), [file.contentType, mode]);

  useEffect(() => {
    if (!shouldLoadBinaryPreview) {
      setBinaryState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setBinaryState({ status: 'loading' });

    void (async () => {
      try {
        if (!fileRuntimeAddress) {
          throw new Error('RuntimeAddress is required');
        }
        const result = await hostFileReadBinary({
          path: file.filePath,
          runtimeAddress: fileRuntimeAddress,
        });
        if (cancelled) {
          return;
        }
        if (!result.ok || typeof result.data !== 'string') {
          if (result.error === 'tooLarge') {
            setBinaryState({ status: 'tooLarge' });
            return;
          }
          setBinaryState({ status: 'error', message: String(result.error ?? 'unknown') });
          return;
        }
        objectUrl = toBlobObjectUrl(
          result.data,
          result.mimeType || file.mimeType || 'application/octet-stream',
        );
        setBinaryState({
          status: 'ready',
          objectUrl,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setBinaryState({
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
  }, [file.filePath, file.mimeType, fileRuntimeAddress, shouldLoadBinaryPreview]);

  const content = (() => {
    if (file.isDirectory) {
      return (
        <PreviewFallbackAction
          label={t('artifacts.directoryPreviewTitle')}
          description={t('artifacts.directoryPreviewDescription')}
          openLabel={shouldConfirmDirectOpen ? t('artifacts.openDirectly') : t('artifacts.openExternal')}
          revealLabel={t('artifacts.reveal')}
          onOpen={() => {
            void openInSystemApp();
          }}
          onReveal={() => {
            void revealInFileManager();
          }}
        />
      );
    }

    if (mode === 'diff') {
      if (!supportsInlineDiff(file)) {
        return (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t('artifacts.diffUnsupported')}
          </div>
        );
      }
      if (file.contentType === 'code') {
        return (
          <MonacoDiffViewer
            key={previewInstanceKey}
            filePath={file.filePath}
            original={file.baseline ?? ''}
            modified={file.content ?? ''}
            className="h-full"
          />
        );
      }
      return (
        <div className="h-full min-h-0 overflow-auto p-3">
          {renderPlainDiff(file)}
        </div>
      );
    }

    if (fileTooLargeForPreview && canDirectOpen) {
      return (
        <PreviewFallbackAction
          label={t('artifacts.previewTooLarge')}
          description={t('artifacts.previewOpenExternalDescription')}
          openLabel={shouldConfirmDirectOpen ? t('artifacts.openDirectly') : t('artifacts.openExternal')}
          revealLabel={t('artifacts.reveal')}
          onOpen={() => {
            void openInSystemApp();
          }}
          onReveal={() => {
            void revealInFileManager();
          }}
        />
      );
    }

    if (file.contentType === 'pdf') {
      return <PdfViewer key={previewInstanceKey} filePath={file.filePath} fileName={file.fileName} runtimeAddress={fileRuntimeAddress} className="h-full" />;
    }

    if (file.contentType === 'image') {
      if (binaryState.status === 'loading' || binaryState.status === 'idle') {
        return (
          <div className="flex h-full items-center justify-center">
            <LoadingSpinner />
          </div>
        );
      }
      if (binaryState.status === 'tooLarge') {
        return (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t('artifacts.previewTooLarge')}
          </div>
        );
      }
      if (binaryState.status === 'error') {
        return (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
            {t('artifacts.previewLoadFailed', { error: binaryState.message })}
          </div>
        );
      }
      return (
        <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-[hsl(var(--muted)/0.3)] p-4">
          <img
            src={binaryState.objectUrl}
            alt={file.fileName}
            className="max-h-full max-w-full rounded-lg border border-border/45 bg-background shadow-sm"
          />
        </div>
      );
    }

    if (file.contentType === 'sheet' && (file.ext === '.xls' || file.ext === '.xlsx')) {
      return <SheetViewer key={previewInstanceKey} filePath={file.filePath} runtimeAddress={fileRuntimeAddress} className="h-full" />;
    }

    if (file.contentType === 'sheet' && file.ext === '.csv') {
      const csvText = textState.status === 'ready' ? textState.content : (file.content ?? '');
      return (
        <div className="h-full min-h-0 overflow-auto p-3">
          <CsvPreview csv={csvText} />
        </div>
      );
    }

    if (file.contentType === 'markdown') {
      const markdownText = textState.status === 'ready' ? textState.content : (file.content ?? '');
      return <MarkdownPreview key={previewInstanceKey} filePath={file.filePath} markdown={markdownText} />;
    }

    if (file.contentType === 'html') {
      const htmlText = textState.status === 'ready' ? textState.content : (file.content ?? '');
      return <HtmlPreview key={previewInstanceKey} fileName={file.fileName} source={htmlText} />;
    }

    if (file.contentType === 'code') {
      const codeText = textState.status === 'ready' ? textState.content : (file.content ?? '');
      return <MonacoViewer key={previewInstanceKey} filePath={file.filePath} value={codeText} className="h-full" />;
    }

    if (file.contentType === 'text') {
      const text = textState.status === 'ready' ? textState.content : (file.content ?? '');
      return (
        <div className="h-full min-h-0 overflow-auto p-3">
          <div className="overflow-hidden rounded-[18px] border border-border/45 bg-background/68 shadow-sm backdrop-blur-sm">
            <pre className="overflow-auto px-4 py-3 text-[12px] leading-6 text-foreground/90">
              {text}
            </pre>
          </div>
        </div>
      );
    }

    if (textState.status === 'loading') {
      return (
        <div className="flex h-full items-center justify-center">
          <LoadingSpinner />
        </div>
      );
    }

    if (textState.status === 'tooLarge') {
      if (canDirectOpen) {
        return (
          <PreviewFallbackAction
            label={t('artifacts.previewTooLarge')}
            description={t('artifacts.previewOpenExternalDescription')}
            openLabel={shouldConfirmDirectOpen ? t('artifacts.openDirectly') : t('artifacts.openExternal')}
            revealLabel={t('artifacts.reveal')}
            onOpen={() => {
              void openInSystemApp();
            }}
            onReveal={() => {
              void revealInFileManager();
            }}
          />
        );
      }
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t('artifacts.previewTooLarge')}
        </div>
      );
    }

    if (textState.status === 'binary') {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t('artifacts.previewBinary')}
        </div>
      );
    }

    if (textState.status === 'error') {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
          {t('artifacts.previewLoadFailed', { error: textState.message })}
        </div>
      );
    }

    return canDirectOpen ? (
      <PreviewFallbackAction
        label={t('artifacts.previewUnsupported')}
        description={t('artifacts.previewOpenExternalDescription')}
        openLabel={shouldConfirmDirectOpen ? t('artifacts.openDirectly') : t('artifacts.openExternal')}
        revealLabel={t('artifacts.reveal')}
        onOpen={() => {
          void openInSystemApp();
        }}
        onReveal={() => {
          void revealInFileManager();
        }}
      />
    ) : (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t('artifacts.previewUnsupported')}
      </div>
    );
  })();

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden', className)}>
      {showHeader ? (
        <div className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{file.fileName}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {headerAccessory}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md"
              onClick={() => void copyFilePath()}
              title={t('artifacts.copyPath')}
              aria-label={t('artifacts.copyPath')}
            >
              {pathCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md"
              onClick={() => {
                void revealInFileManager();
              }}
              title={t('artifacts.reveal')}
              aria-label={t('artifacts.reveal')}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md"
              onClick={() => {
                void openInSystemApp();
              }}
              title={shouldConfirmDirectOpen ? t('artifacts.openDirectly') : t('artifacts.openExternal')}
              aria-label={shouldConfirmDirectOpen ? t('artifacts.openDirectly') : t('artifacts.openExternal')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
            {headerTrailingAccessory}
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {content}
      </div>
    </div>
  );
}
