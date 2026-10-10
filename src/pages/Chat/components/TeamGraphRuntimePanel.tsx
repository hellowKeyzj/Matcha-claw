import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTeamRunLabels } from '@/hooks/use-team-run-labels';
import { useTeamsStore } from '@/stores/teams';
import { TeamRunGraphCanvas } from '@/pages/Teams/TeamRunGraphCanvas';
import { useTeamGraphLabels } from '@/pages/Teams/team-graph-labels';
import type { ChatRuntimeSurfaceDescriptor } from '../useChatSidePanelController';

type TeamGraphSurface = Extract<ChatRuntimeSurfaceDescriptor, { kind: 'team-graph' }>;

export function TeamGraphRuntimePanel({ surface }: { surface: TeamGraphSurface }) {
  const { t } = useTranslation('teams');
  const runLabels = useTeamRunLabels();
  const runTitle = runLabels[surface.runId] ?? t('run.unnamed');
  const teamName = useTeamsStore((state) => state.teams.find((team) => team.id === surface.teamId)?.name);
  const target = useMemo(() => ({ teamId: surface.teamId, runId: surface.runId }), [surface.teamId, surface.runId]);
  const record = useTeamsStore((state) => state.designByRunId[surface.runId]);
  const observeTeamDesign = useTeamsStore((state) => state.observeTeamDesign);
  const refreshDesignSnapshot = useTeamsStore((state) => state.refreshDesignSnapshot);
  const snapshot = record?.snapshot?.teamId === surface.teamId && record.snapshot.runId === surface.runId
    ? record.snapshot
    : null;
  const labels = useTeamGraphLabels();

  useEffect(() => observeTeamDesign(target), [observeTeamDesign, target]);

  const copyRunId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(surface.runId);
      toast.success(t('run.idCopied'));
    } catch {
      toast.error(t('run.copyIdFailed'));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-3 py-3">
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={surface.teamId}>{teamName}</p>
          <div className="mt-1 flex min-w-0 items-center gap-1">
            <p className="truncate text-xs text-muted-foreground" title={`${runTitle}\n${surface.runId}`}>{runTitle}</p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              aria-label={t('run.copyId')}
              title={t('run.copyId')}
              onClick={() => { void copyRunId(); }}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={t('common:actions.refresh')}
          title={t('common:actions.refresh')}
          disabled={record?.loading}
          onClick={() => void refreshDesignSnapshot(target, { invalidate: true }).catch(() => {})}
        >
          <RefreshCw className={record?.loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>
      {record?.error ? <p role="alert" className="text-xs text-destructive">{record.error}</p> : null}
      {!snapshot && !record?.error ? (
        <div role="status" className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t('common:status.loading')} />
        </div>
      ) : snapshot ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TeamRunGraphCanvas
            mode="readonly"
            compact
            graph={snapshot.graph}
            roles={snapshot.roles}
            emptyLabel={t('run.emptyWorkflow')}
            titleLabel={t('run.graph')}
            executorLabel={t('run.executor')}
            labels={labels}
          />
        </div>
      ) : <p className="py-8 text-center text-sm text-muted-foreground">{t('run.emptyWorkflow')}</p>}
    </div>
  );
}
