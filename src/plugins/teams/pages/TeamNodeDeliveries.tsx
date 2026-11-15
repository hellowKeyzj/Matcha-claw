import { useTranslation } from 'react-i18next';
import { FileText, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/plugins/chat/store';
import { useWorkspace } from '@/plugins/workspace/context';
import type { TeamRoleBindingRecord } from '@/types/team-design';
import type { TeamArtifactRecord } from '@/types/team-workspace';
import { useTeamFilePreview } from './team-file-preview-context';

function deliverySession(artifact: TeamArtifactRecord, roles: TeamRoleBindingRecord[]): TeamRoleBindingRecord | undefined {
  const identity = artifact.agentIdentity;
  if (!identity || !artifact.sessionRef) return undefined;
  return roles.find((role) => role.runId === artifact.runId && role.roleId === artifact.roleId && role.sessionRef === artifact.sessionRef
    && role.agentId === identity.agentId && role.endpointRef.kind === 'native-runtime' && role.endpointRef.runtimeInstanceId === 'local'
    && (identity.endpointRef === 'endpoint:openclaw' && role.endpointRef.runtimeAdapterId === 'openclaw'
      || identity.endpointRef === 'endpoint:matcha' && role.endpointRef.runtimeAdapterId === 'matcha-agent'));
}

export function TeamNodeDeliveries({ artifacts, loading, roles, disabled, onReveal, contextTitle, variant = 'delivery', omitDeliveredAt, previewOwnerId }: {
  artifacts: TeamArtifactRecord[];
  loading: boolean;
  roles: TeamRoleBindingRecord[];
  disabled: boolean;
  onReveal: () => void;
  contextTitle?: string;
  variant?: 'delivery' | 'input';
  omitDeliveredAt?: string;
  previewOwnerId?: string;
}) {
  const { t, i18n } = useTranslation('teams');
  const workspace = useWorkspace();
  const { ready, workspaceStatus, selectFile } = useTeamFilePreview();

  return <section aria-label={t(variant === 'input' ? 'workspace.input' : 'delivery.records')} className="space-y-4">
    {artifacts.length === 0 ? <p role="status" className="py-8 text-center text-sm text-muted-foreground">{t(loading ? 'delivery.loading' : 'delivery.empty')}</p> : <ol className="divide-y">
      {artifacts.map((artifact) => {
        const binding = deliverySession(artifact, roles);
        const deliveredAt = artifact.createdAt > 0 ? new Date(artifact.createdAt).toLocaleString(i18n.language) : '';
        return <li key={artifact.artifactId} className="space-y-4 py-5 first:pt-0 last:pb-0">
          {artifact.title !== contextTitle ? <h3 className="break-words text-sm font-semibold [overflow-wrap:anywhere]">{artifact.title}</h3> : null}
          {artifact.summary ? <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t(variant === 'input' ? 'workspace.upstreamSummary' : 'delivery.summary')}</p>
            <p className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]">{artifact.summary}</p>
          </div> : null}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">{t(variant === 'input' ? 'workspace.inputFiles' : 'delivery.files')}</h4>
            {artifact.files.length === 0 ? <p className="text-xs text-muted-foreground">{t('delivery.noFiles')}</p> : <ul className="space-y-2">
              {artifact.files.map((path) => <li key={path}><button type="button" onClick={() => selectFile({ artifactId: artifact.artifactId, filePath: path }, previewOwnerId)} disabled={disabled || !ready}
                aria-label={t('delivery.openFile', { path })} title={path} data-team-file={JSON.stringify([artifact.artifactId, path])}
                className="flex w-full items-center gap-3 rounded-lg border bg-muted/20 px-3 py-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60">
                <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 break-all">{path}</span>
              </button></li>)}
            </ul>}
          </div>
          {artifact.files.length > 0 && !ready ? <p role="status" className="text-xs text-muted-foreground">{t(workspaceStatus === 'legacy' ? 'delivery.legacyWorkspace' : 'delivery.preparingWorkspace')}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {binding ? <Button type="button" size="sm" variant="ghost" className="-ml-2 gap-1.5" disabled={disabled} onClick={() => {
              onReveal();
              workspace.showChat();
              useChatStore.getState().openSessionIdentity({ sessionIdentity: binding.sessionIdentity, endpointSessionId: binding.endpointSessionId });
            }}><MessageSquare aria-hidden="true" className="h-3.5 w-3.5" />{t('delivery.openSession')}</Button> : <span className="text-xs text-muted-foreground">{t('delivery.sessionUnavailable')}</span>}
            {variant === 'delivery' ? <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {deliveredAt && deliveredAt !== omitDeliveredAt ? <span>{t('delivery.deliveredAt')} <time dateTime={new Date(artifact.createdAt).toISOString()}>{deliveredAt}</time></span> : null}
              <span>{t(artifact.currentAttempt ? 'delivery.currentAttempt' : 'delivery.previousAttempt')}</span>
            </div> : null}
          </div>
        </li>;
      })}
    </ol>}
  </section>;
}
