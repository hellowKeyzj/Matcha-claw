import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FilePreviewBody } from '@/plugins/files/FilePreviewBody';
import { buildArtifactPreviewTargetFromPath } from '@/plugins/files/types';
import type { TeamRunScope } from '@/types/desktop/runtime-address';
import type { RunWorkspaceProjection, TeamArtifactRecord } from '@/types/team-workspace';
import type { TeamNodeDeliverySelection } from './team-node-editor-types';
import { TeamFilePreviewContext } from './team-file-preview-context';

export function TeamFilePreview({ artifacts, fileScope, workspaceStatus, initialSelection, disabled, children }: {
  artifacts: TeamArtifactRecord[];
  fileScope?: TeamRunScope;
  workspaceStatus?: RunWorkspaceProjection['status'];
  initialSelection?: TeamNodeDeliverySelection;
  disabled: boolean;
  children: ReactNode | ((previewOwnerId?: string) => ReactNode);
}) {
  const { t } = useTranslation(['teams', 'common']);
  const [selection, setSelection] = useState<(TeamNodeDeliverySelection & { ownerId?: string }) | undefined>(initialSelection);
  const contentRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const ready = Boolean(fileScope && workspaceStatus === 'ready');
  const selectedArtifact = artifacts.find((artifact) => artifact.artifactId === selection?.artifactId);
  const selectedPath = selection?.filePath && selectedArtifact?.files.includes(selection.filePath) ? selection.filePath : null;
  const preview = useMemo(() => selectedPath ? buildArtifactPreviewTargetFromPath(selectedPath) : null, [selectedPath]);
  const workspaceContext = useMemo(() => ({ scope: fileScope }), [fileScope]);
  const previewing = Boolean(preview && ready);
  const selectFile = useCallback((next: TeamNodeDeliverySelection, ownerId?: string) => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelection({ ...next, ownerId });
  }, []);
  const ownerId = previewing ? selection?.ownerId : undefined;
  const context = useMemo(() => ({ ready, workspaceStatus, selectFile }), [ready, workspaceStatus, selectFile]);

  useLayoutEffect(() => {
    if (previewing) backRef.current?.focus({ preventScroll: true });
    else if (returnFocusRef.current?.isConnected) {
      returnFocusRef.current.focus({ preventScroll: true });
      returnFocusRef.current = null;
    }
  }, [previewing]);

  return <TeamFilePreviewContext.Provider value={context}>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {preview && ready ? <section aria-label={t('workspace.previewFile')} className="flex min-h-0 flex-1 flex-col">
        <FilePreviewBody file={preview} mode="preview" workspaceContext={workspaceContext}
          className="[&_.chat-markdown]:mx-auto [&_.chat-markdown]:max-w-[680px]"
          headerLeadingAccessory={<Button ref={backRef} type="button" size="sm" variant="ghost" className="mr-1 h-7 shrink-0 gap-1.5 rounded-md px-2 text-xs max-[480px]:w-7 max-[480px]:gap-0" title={t('common:actions.back')} disabled={disabled} onClick={() => {
            if (!returnFocusRef.current?.isConnected && selection) {
              const key = CSS.escape(JSON.stringify([selection.artifactId, selection.filePath]));
              returnFocusRef.current = contentRef.current?.querySelector<HTMLButtonElement>(`[data-team-file="${key}"]`) ?? null;
            }
            setSelection(undefined);
          }}>
            <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" /><span className="max-[480px]:sr-only">{t('common:actions.back')}</span>
          </Button>} />
      </section> : null}
      <div ref={contentRef} hidden={previewing && typeof children !== 'function'} className={typeof children === 'function' ? 'contents' : 'min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]'}>
        {typeof children === 'function' ? children(ownerId) : children}
      </div>
    </div>
  </TeamFilePreviewContext.Provider>;
}
