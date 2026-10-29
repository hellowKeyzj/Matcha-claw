import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { hostFileReadBinary, hostFileReadText, type WorkspaceFileContext } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import { useContributions } from '@/plugin-host/react';
import { AppPluginManager } from '@/plugins/application-plugins/AppPluginManager';
import { fileFormats, fileReaders, findFileReader, resolveFilePreviewTarget, type FilePreviewMode, type FileReaderContribution } from './extensions';
import { resolveWorkspaceRelativePath, type ArtifactPreviewTarget } from './types';
import { confirmAndOpenArtifactPath, openArtifactPathExternally, revealArtifactPathInFileManager, shouldOfferDirectOpenFallback } from './open-file-utils';

export type { FilePreviewMode } from './extensions';
const INLINE_BINARY_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

interface FilePreviewBodyProps {
  file: ArtifactPreviewTarget;
  mode: FilePreviewMode;
  className?: string;
  showHeader?: boolean;
  headerLeadingAccessory?: ReactNode;
  headerAccessory?: ReactNode;
  headerTrailingAccessory?: ReactNode;
  workspaceContext?: WorkspaceFileContext;
}

type FileReadState =
  | { status: 'loading' }
  | { status: 'text'; content: string }
  | { status: 'binary'; data: ArrayBuffer }
  | { status: 'tooLarge' | 'unsupportedBinary' }
  | { status: 'error'; message: string };

function PreviewLoading() {
  return <div className="flex h-full items-center justify-center"><LoadingSpinner /></div>;
}

function WorkspaceFileReader({ file, reader, relativePath, workspaceContext, tooLargeFallback }: {
  file: ArtifactPreviewTarget;
  reader: Exclude<FileReaderContribution, { source: 'snapshot' }>;
  relativePath: string | null;
  workspaceContext?: WorkspaceFileContext;
  tooLargeFallback: ReactNode;
}) {
  const { t } = useTranslation('chat');
  const [state, setState] = useState<FileReadState>({ status: 'loading' });
  const endpoint = workspaceContext?.agentScope?.endpoint;
  const agentId = workspaceContext?.agentScope?.agentId;
  const source = reader.source;

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        if (!endpoint || !agentId) throw new Error('AgentScope is required');
        if (!relativePath) throw new Error('Workspace relative path is unavailable');
        const payload = { endpoint, agentId, relativePath };
        if (source === 'text') {
          const result = await hostFileReadText(payload);
          if (cancelled) return;
          if (result.ok && typeof result.content === 'string') {
            setState({ status: 'text', content: result.content });
          } else if (result.error === 'tooLarge') {
            setState({ status: 'tooLarge' });
          } else if (result.error === 'binary') {
            setState({ status: 'unsupportedBinary' });
          } else {
            setState({ status: 'error', message: String(result.error ?? 'unknown') });
          }
          return;
        }
        const result = await hostFileReadBinary({ ...payload, maxBytes: INLINE_BINARY_PREVIEW_MAX_BYTES });
        if (cancelled) return;
        if (!result.ok || typeof result.data !== 'string') {
          setState(result.error === 'tooLarge'
            ? { status: 'tooLarge' }
            : { status: 'error', message: String(result.error ?? 'unknown') });
          return;
        }
        const binary = window.atob(result.data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        setState({ status: 'binary', data: bytes.buffer });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; };
  }, [endpoint, agentId, relativePath, source]);

  if (state.status === 'tooLarge') return tooLargeFallback;
  if (state.status === 'unsupportedBinary') {
    return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">{t('artifacts.previewBinary')}</div>;
  }
  if (state.status === 'error') {
    return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{t('artifacts.previewLoadFailed', { error: state.message })}</div>;
  }
  if (reader.source === 'text' && state.status === 'text') {
    const Reader = reader.component;
    return <Reader file={file} text={state.content} />;
  }
  if (reader.source === 'binary' && state.status === 'binary') {
    const Reader = reader.component;
    return <Reader file={file} data={state.data} />;
  }
  return <PreviewLoading />;
}

function PreviewFallbackAction({
  label,
  description,
  openLabel,
  revealLabel,
  onOpen,
  onReveal,
  disabled,
  className,
}: {
  label: string;
  description: string;
  openLabel: string;
  revealLabel: string;
  onOpen: () => void;
  onReveal: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex h-full items-center justify-center px-6 py-8', className)}>
      <div className="max-w-md rounded-[18px] border border-border/45 bg-background p-5 text-center shadow-sm">
        <p className="text-sm text-foreground">{label}</p>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button type="button" size="sm" className="gap-1.5" onClick={onOpen} disabled={disabled}>
            <ExternalLink className="h-3.5 w-3.5" />
            {openLabel}
          </Button>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onReveal} disabled={disabled}>
            <FolderOpen className="h-3.5 w-3.5" />
            {revealLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function FilePreviewBody({
  file: inputFile,
  mode,
  className,
  showHeader = true,
  headerLeadingAccessory,
  headerAccessory,
  headerTrailingAccessory,
  workspaceContext,
}: FilePreviewBodyProps) {
  const { t } = useTranslation(['chat', 'common']);
  const formats = useContributions(fileFormats);
  const readers = useContributions(fileReaders);
  const file = resolveFilePreviewTarget(inputFile, formats);
  const reader = findFileReader(readers, file, mode);
  const [pathCopied, setPathCopied] = useState(false);
  const shouldUseInlineSnapshot = file.sourceTool !== 'write' && !!file.content;
  const transportRelativePath = resolveWorkspaceRelativePath(
    file.relativePath ?? file.filePath,
    workspaceContext?.workspaceRoot,
  );
  const canDirectOpen = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/u.test(file.filePath);
  const fileTooLargeForPreview = typeof file.fileSize === 'number' && file.fileSize > INLINE_BINARY_PREVIEW_MAX_BYTES;
  const shouldConfirmDirectOpen = shouldOfferDirectOpenFallback(file.ext, file.fileSize);
  const openInSystemApp = useCallback(async () => {
    if (!canDirectOpen) return;
    try {
      if (shouldConfirmDirectOpen) {
        await confirmAndOpenArtifactPath({ filePath: file.filePath, fileName: file.fileName, size: file.fileSize, t });
        return;
      }
      const error = await openArtifactPathExternally(file.filePath);
      if (error) throw new Error(error);
    } catch (error) {
      toast.error(t('artifacts.openFailed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [canDirectOpen, file.fileName, file.filePath, file.fileSize, shouldConfirmDirectOpen, t]);
  const revealInFileManager = useCallback(async () => {
    if (!canDirectOpen) return;
    const success = await revealArtifactPathInFileManager(file.filePath);
    if (!success) toast.error(t('artifacts.revealFailed'));
  }, [canDirectOpen, file.filePath, t]);

  useEffect(() => { setPathCopied(false); }, [file.filePath]);
  const copyFilePath = useCallback(async () => {
    if (!file.filePath) return;
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

  const renderFallback = (label: string, description: string) => (
    <PreviewFallbackAction
      disabled={!canDirectOpen}
      label={label}
      description={description}
      openLabel={shouldConfirmDirectOpen ? t('artifacts.openDirectly') : t('artifacts.openExternal')}
      revealLabel={t('artifacts.reveal')}
      onOpen={() => { void openInSystemApp(); }}
      onReveal={() => { void revealInFileManager(); }}
    />
  );
  const tooLargeFallback = canDirectOpen
    ? renderFallback(t('artifacts.previewTooLarge'), t('artifacts.previewOpenExternalDescription'))
    : <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">{t('artifacts.previewTooLarge')}</div>;
  const content = (() => {
    if (file.isDirectory) return renderFallback(t('artifacts.directoryPreviewTitle'), t('artifacts.directoryPreviewDescription'));
    if (mode === 'preview' && fileTooLargeForPreview && canDirectOpen) return tooLargeFallback;
    if (!reader) {
      if (mode === 'diff') return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">{t('artifacts.diffUnsupported')}</div>;
      return canDirectOpen
        ? renderFallback(t('artifacts.previewUnsupported'), t('artifacts.previewOpenExternalDescription'))
        : <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">{t('artifacts.previewUnsupported')}</div>;
    }
    if (reader.source === 'snapshot') {
      const Reader = reader.component;
      return <Reader file={file} />;
    }
    if (reader.source === 'text' && shouldUseInlineSnapshot) {
      const Reader = reader.component;
      return <Reader file={file} text={file.content!} />;
    }
    return <WorkspaceFileReader file={file} reader={reader} relativePath={transportRelativePath} workspaceContext={workspaceContext} tooLargeFallback={tooLargeFallback} />;
  })();
  const previewInstanceKey = JSON.stringify([workspaceContext?.agentScope, transportRelativePath, file.filePath, mode, reader?.id]);

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden', className)}>
      {showHeader ? (
        <div className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {headerLeadingAccessory}
            <p className="truncate text-sm font-medium text-foreground">{file.fileName}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {headerAccessory}
            <AppPluginManager category="reader" compact />
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
              onClick={() => { void revealInFileManager(); }}
              title={t('artifacts.reveal')}
              aria-label={t('artifacts.reveal')}
              disabled={!canDirectOpen}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md"
              onClick={() => { void openInSystemApp(); }}
              title={shouldConfirmDirectOpen ? t('artifacts.openDirectly') : t('artifacts.openExternal')}
              aria-label={shouldConfirmDirectOpen ? t('artifacts.openDirectly') : t('artifacts.openExternal')}
              disabled={!canDirectOpen}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
            {headerTrailingAccessory}
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense key={previewInstanceKey} fallback={<PreviewLoading />}>{content}</Suspense>
      </div>
    </div>
  );
}
