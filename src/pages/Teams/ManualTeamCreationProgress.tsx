import { useEffect, useState } from 'react';
import { AlertCircle, Check, Circle, Loader2, Minus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import type { ManualTeamCreation, ManualTeamCreationPhase } from '@/types/team-creation';

const creationSteps = [
  'submitting',
  'reading_profiles',
  'generating_introductions',
  'configuring_team',
  'verifying_team',
  'saving_team',
  'initializing_sessions',
  'loading_team',
] as const satisfies readonly ManualTeamCreationPhase[];

type StepStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'unconfirmed' | 'incomplete';

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === 'running') return <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />;
  if (status === 'completed') return <Check aria-hidden="true" className="h-4 w-4" />;
  if (status === 'failed') return <X aria-hidden="true" className="h-4 w-4" />;
  if (status === 'unconfirmed') return <AlertCircle aria-hidden="true" className="h-4 w-4" />;
  if (status === 'skipped') return <Minus aria-hidden="true" className="h-4 w-4" />;
  return <Circle aria-hidden="true" className="h-4 w-4" />;
}

function CreationElapsed({ startedAt, endedAt }: { startedAt: number; endedAt: number | null }) {
  const { t } = useTranslation('teams');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (endedAt !== null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [endedAt]);
  const seconds = Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000));
  return <span className="text-xs tabular-nums text-muted-foreground">{t('create.manualProgress.elapsed', { seconds })}</span>;
}

export function ManualTeamCreationProgress({ creation }: { creation: ManualTeamCreation }) {
  const { t } = useTranslation('teams');
  const members = creation.candidate.manualTeam.members.filter((member) => !member.isLeader);
  const memberStatuses = creation.progress?.members ?? [];
  const completedCount = memberStatuses.filter((status) => status === 'completed').length;
  const failedCount = memberStatuses.filter((status) => status === 'failed').length;
  const runningCount = memberStatuses.filter((status) => status === 'running').length;
  const queuedCount = memberStatuses.filter((status) => status === 'queued').length;
  const activePhase = creation.phase;
  const rollingBack = activePhase === 'rolling_back';
  const currentStep = creationSteps.findIndex((step) => step === activePhase);
  const isActive = creation.status === 'running' || creation.status === 'cleaning_up';
  const endedAt = creation.endedAt;
  const preparationSkipped = members.length === 0;
  const preparationNotObserved = !preparationSkipped && !creation.preparationObserved
    && (rollingBack || currentStep >= creationSteps.indexOf('configuring_team'));
  const currentStageLabel = t(`create.manualProgress.stages.${activePhase}`);

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
      <div className="rounded-2xl border border-border bg-background p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words text-lg font-semibold text-foreground">{creation.candidate.displayName}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('create.manualProgress.currentStage', { stage: currentStageLabel })}</p>
          </div>
          <CreationElapsed startedAt={creation.startedAt} endedAt={endedAt} />
        </div>
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {t(`create.manualProgress.status.${creation.status}`)}. {currentStageLabel}. {t('create.manualProgress.memberSummary', { completed: completedCount, failed: failedCount, total: members.length })}
          {creation.status === 'running' ? t('create.manualProgress.memberActivity', { running: runningCount, queued: queuedCount }) : null}
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {creation.status === 'unconfirmed' ? t('create.manualProgress.unconfirmedDescription') : isActive ? t('create.manualProgress.runningDescription') : t('create.manualProgress.failedDescription')}
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ol className="space-y-1" aria-label={t('create.manualProgress.stepsLabel')}>
          {creationSteps.map((step, index) => {
            const preparationStep = step === 'reading_profiles' || step === 'generating_introductions';
            const skipped = preparationSkipped && preparationStep;
            const notObserved = preparationNotObserved && preparationStep;
            const status: StepStatus = skipped ? 'skipped'
              : notObserved ? 'unconfirmed'
              : rollingBack ? index <= creationSteps.indexOf('generating_introductions') ? 'completed'
                : step === 'configuring_team' || step === 'verifying_team' || step === 'saving_team' ? 'unconfirmed' : 'queued'
              : index < currentStep ? 'completed'
                : index > currentStep ? 'queued'
                  : creation.status === 'failed' ? 'failed'
                    : creation.status === 'unconfirmed' ? 'unconfirmed'
                      : creation.status === 'cleaning_up' ? 'failed' : 'running';
            return (
              <li key={step} aria-current={index === currentStep ? 'step' : undefined} className="relative flex items-center gap-3 py-2">
                {index < creationSteps.length - 1 ? <span aria-hidden="true" className="absolute left-4 top-9 h-4 w-px bg-border" /> : null}
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${status === 'completed' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : status === 'failed' ? 'bg-destructive/10 text-destructive' : status === 'unconfirmed' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : status === 'running' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  <StatusIcon status={status} />
                </span>
                <span className="min-w-0 flex-1 text-sm text-foreground">{t(`create.manualProgress.stages.${step}`)}</span>
                <span className="text-xs text-muted-foreground">{notObserved ? t('create.manualProgress.stepNotObserved') : status === 'completed' ? t('create.manualProgress.stepCompleted') : t(`create.manualProgress.memberStatus.${status}`)}</span>
              </li>
            );
          })}
          {rollingBack ? (
            <li aria-current="step" className="flex items-center gap-3 py-2 text-sm text-amber-800 dark:text-amber-200">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10"><StatusIcon status={isActive ? 'running' : creation.status === 'failed' ? 'failed' : 'unconfirmed'} /></span>
              <span>{currentStageLabel}</span>
            </li>
          ) : null}
        </ol>

        <div className="min-w-0 rounded-2xl border border-border bg-background p-4">
          <h4 className="text-sm font-medium text-foreground">{t('create.manualProgress.membersTitle')}</h4>
          <p className="mt-1 text-xs text-muted-foreground">{t('create.manualProgress.memberSummary', { completed: completedCount, failed: failedCount, total: members.length })}</p>
          {members.length === 0 ? (
            <p className="mt-4 text-sm leading-6 text-muted-foreground">{t('create.manualProgress.noMembers')}</p>
          ) : preparationNotObserved ? (
            <p className="mt-3 text-xs text-muted-foreground">{t('create.manualProgress.preparationNotObserved')}</p>
          ) : null}
          <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto">
            {members.map((member, index) => {
              const observedStatus = memberStatuses[index] ?? 'queued';
              const status = preparationSkipped ? 'skipped'
                : creation.status !== 'running' && (observedStatus === 'running' || observedStatus === 'queued')
                  ? creation.status === 'unconfirmed' ? 'unconfirmed' : 'incomplete'
                  : observedStatus;
              return (
                <li key={member.roleId} className="flex items-center gap-3 rounded-xl bg-muted/25 p-2.5">
                  <AgentAvatar agentId={member.agentId} agentName={member.agentName} alt="" className="h-8 w-8 border border-border" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{member.agentName}</span>
                  <span className={`flex items-center gap-1.5 text-xs ${status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
                    <StatusIcon status={status} />
                    {t(`create.manualProgress.memberStatus.${status}`)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {creation.error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <div className="font-medium">{t('create.manualProgress.originalError')}</div>
          <p className="mt-1 break-words">{creation.error}</p>
        </div>
      ) : null}
      {creation.status !== 'running' ? (
        <div className={`rounded-xl border px-4 py-3 text-sm ${creation.status === 'failed' ? 'border-border bg-muted/25 text-muted-foreground' : 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200'}`}>
          <div className="mb-1 font-medium">{t('create.manualProgress.cleanupTitle')}</div>
          {creation.status === 'cleaning_up' ? t('create.manualProgress.cleaningUp')
            : creation.cleanup === 'confirmed' ? t('create.manualProgress.cleanupConfirmed')
              : creation.cleanup === 'unknown' ? t('create.manualProgress.cleanupUnknown')
                : t('create.manualProgress.unconfirmedDescription')}
        </div>
      ) : null}
    </div>
  );
}
