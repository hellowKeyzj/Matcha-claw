import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTeamsStore } from '@/stores/teams';
import { TeamRunGraphCanvas } from '@/pages/Teams/TeamRunGraphCanvas';
import { useTeamGraphLabels } from '@/pages/Teams/team-graph-labels';
import type { ChatRuntimeSurfaceDescriptor } from '../useChatSidePanelController';

type TeamGraphSurface = Extract<ChatRuntimeSurfaceDescriptor, { kind: 'team-graph' }>;

export function TeamGraphRuntimePanel({ surface }: { surface: TeamGraphSurface }) {
  const { t } = useTranslation('teams');
  const target = useMemo(() => ({ teamId: surface.teamId, runId: surface.runId }), [surface.teamId, surface.runId]);
  const record = useTeamsStore((state) => state.designByRunId[surface.runId]);
  const observeTeamDesign = useTeamsStore((state) => state.observeTeamDesign);
  const refreshDesignSnapshot = useTeamsStore((state) => state.refreshDesignSnapshot);
  const snapshot = record?.snapshot?.teamId === surface.teamId && record.snapshot.runId === surface.runId
    ? record.snapshot
    : null;
  const labels = useTeamGraphLabels();

  useEffect(() => observeTeamDesign(target), [observeTeamDesign, target]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-3 py-3">
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={surface.title}>{surface.title ?? t('run.graph')}</p>
          <p className="mt-1 break-all text-xs text-muted-foreground">{surface.teamId} · {surface.runId}</p>
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
