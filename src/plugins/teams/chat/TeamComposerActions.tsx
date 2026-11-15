import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { ArrowUpRight, GitBranch, Loader2, Play } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ChatComposerContentProps } from '@/plugins/chat/extensions';
import { isRuntimeEndpointReady, supportsRuntimeEndpointCapabilityFamily, useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import { buildSessionIdentityKey, runtimeEndpointsEqual } from '@/types/desktop/runtime-address';
import type { TeamDesignTarget } from '@/types/team-design';
import { selectTeamRuntimeScope, useTeamsStore } from '../store';
import { openTeamGraph } from './runtime-surface';
import { useTeamRunStartEligibility } from './use-team-run-start-eligibility';

export const TeamComposerActions = memo(function TeamComposerActions({ sessionIdentity, ownership, enabled, runActive, imageGenerationActive, approvalWaiting, canSend, focusComposer }: ChatComposerContentProps) {
  const { t } = useTranslation('chat');
  const runtimeEndpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const teamGraphTeamId = ownership?.kind === 'team' ? ownership.teamId : null;
  const teamGraphRunId = ownership?.kind === 'team' ? ownership.teamRunId : null;
  const designTeamId = ownership?.kind === 'team' && ownership.roleId === 'leader' ? teamGraphTeamId : null;
  const designRunId = ownership?.kind === 'team' && ownership.roleId === 'leader' ? teamGraphRunId : null;
  const { canStartRun, canStartRunNow } = useTeamRunStartEligibility(designTeamId, designRunId, sessionIdentity);
  const { designTeamKnown, designRuntimeAvailable, designActionPending, teamDesignStatus, teamDesignError,
    observeTeamDesign, startDesign, startRun, exitDesign } = useTeamsStore(useShallow((state) => {
    const designTeamKnown = Boolean(designTeamId && state.teams.some((team) => team.id === designTeamId));
    const scope = designTeamKnown && designTeamId && designRunId ? selectTeamRuntimeScope(state, designTeamId, designRunId) : null;
    const record = designRunId ? state.designByRunId[designRunId] : undefined;
    const snapshot = record?.snapshot;
    return {
      designTeamKnown,
      designRuntimeAvailable: Boolean(scope && runtimeEndpoints.some((entry) => runtimeEndpointsEqual(entry.endpointRef, scope.endpoint)
        && isRuntimeEndpointReady(entry) && supportsRuntimeEndpointCapabilityFamily(entry, 'team'))),
      designActionPending: Boolean(record?.mutationPending),
      teamDesignStatus: snapshot?.teamId === designTeamId && snapshot?.runId === designRunId ? snapshot.startGate.status : null,
      teamDesignError: record?.error ?? null,
      observeTeamDesign: state.observeTeamDesign, startDesign: state.startDesign, startRun: state.startRun, exitDesign: state.exitDesign,
    };
  }));
  const designContextKey = JSON.stringify([designTeamId, designRunId, sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null]);
  const [pendingDesignAction, setPendingDesignAction] = useState<{ contextKey: string; action: 'start' | 'exit' } | null>(null);
  const currentDesignContextRef = useRef<string | null>(designContextKey);
  useLayoutEffect(() => {
    currentDesignContextRef.current = designContextKey;
    return () => { currentDesignContextRef.current = null; };
  }, [designContextKey]);
  useEffect(() => {
    if (!enabled || !designRuntimeAvailable || !designTeamKnown || !designTeamId || !designRunId) return;
    return observeTeamDesign({ teamId: designTeamId, runId: designRunId });
  }, [enabled, designRuntimeAvailable, designTeamKnown, designTeamId, designRunId, observeTeamDesign]);
  const designActionDisabled = !designTeamKnown || teamDesignStatus === null || teamDesignStatus === 'started'
    || designActionPending || pendingDesignAction?.contextKey === designContextKey || !designRuntimeAvailable || !enabled
    || runActive || imageGenerationActive || approvalWaiting || !canSend;
  const runDesignAction = useCallback(async (action: (target: TeamDesignTarget) => Promise<void>, shouldFocusComposer = false): Promise<void> => {
    if (!designTeamId || !designRunId || designActionDisabled || action === startRun && !canStartRunNow()) return;
    const contextKey = designContextKey;
    const pending: typeof pendingDesignAction = action === startRun ? { contextKey, action: 'start' }
      : action === exitDesign ? { contextKey, action: 'exit' } : null;
    if (pending) setPendingDesignAction(pending);
    try {
      await action({ teamId: designTeamId, runId: designRunId });
      if (currentDesignContextRef.current !== contextKey) return;
      if (action === startRun && sessionIdentity) {
        openTeamGraph({ kind: 'team-graph', sourceSessionIdentity: sessionIdentity, teamId: designTeamId, runId: designRunId });
      }
      if (shouldFocusComposer) focusComposer();
    } catch (error) {
      if (currentDesignContextRef.current === contextKey) toast.error(t('teams:design.actionFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (pending) setPendingDesignAction((current) => current === pending ? null : current);
    }
  }, [focusComposer, sessionIdentity, designActionDisabled, canStartRunNow, designContextKey, designRunId, designTeamId, exitDesign, startRun, t]);
  const teamDesignStarting = designActionPending && pendingDesignAction?.contextKey === designContextKey && pendingDesignAction.action === 'start';
  const teamDesignExiting = designActionPending && pendingDesignAction?.contextKey === designContextKey && pendingDesignAction.action === 'exit';
  const teamDesignExitWaiting = runActive || approvalWaiting || !canSend;
  if (!teamGraphTeamId || !teamGraphRunId || !sessionIdentity) return null;
  const hasDesignActions = Boolean(designTeamId && designRunId);
  const canOpenTeamGraph = !hasDesignActions || teamDesignStatus === 'designing' || teamDesignStatus === 'started';
  const openGraph = () => {
    openTeamGraph({ kind: 'team-graph', sourceSessionIdentity: sessionIdentity, teamId: teamGraphTeamId, runId: teamGraphRunId });
  };
  return <>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 max-md:px-2.5 max-sm:px-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 rounded-md px-2 text-foreground"
        disabled={!canOpenTeamGraph && designActionDisabled}
        onClick={canOpenTeamGraph ? openGraph : () => {
          openGraph();
          void runDesignAction(startDesign, true);
        }}
      >
        <GitBranch aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span role={teamDesignStatus === 'designing' ? 'status' : undefined} className="truncate">{t(!hasDesignActions || teamDesignStatus === 'started' ? 'input.teamRunGraphView' : teamDesignStatus === 'designing' ? 'input.teamDesignInProgress' : 'input.teamDesignStart')}</span>
        {canOpenTeamGraph ? <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : null}
      </Button>
      {hasDesignActions && teamDesignStatus !== 'started' ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {teamDesignStatus === 'designing' ? (
            <span title={t(teamDesignExitWaiting ? 'input.teamDesignExitWaiting' : 'input.teamDesignExit')}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 rounded-md px-2.5 text-foreground"
                disabled={designActionDisabled}
                onClick={() => { void runDesignAction(exitDesign, true); }}
                aria-busy={teamDesignExiting}
              >
                {teamDesignExiting ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : null}
                {t(teamDesignExiting ? 'input.teamDesignExiting' : 'teams:design.discuss')}
              </Button>
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 rounded-md px-3"
            disabled={designActionDisabled || !canStartRun}
            onClick={() => { void runDesignAction(startRun); }}
            aria-busy={teamDesignStarting}
          >
            {teamDesignStarting
              ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              : <Play aria-hidden="true" className="h-3.5 w-3.5" />}
            {t(teamDesignStarting ? 'teams:design.starting' : 'teams:design.run')}
          </Button>
        </div>
      ) : null}
    </div>
    {hasDesignActions && teamDesignError ? <p role="alert" className="mb-2 text-xs text-destructive">{teamDesignError}</p> : null}
  </>;
});
