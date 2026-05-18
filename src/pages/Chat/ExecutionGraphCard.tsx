import { memo, useCallback, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import { ArrowDown, ArrowUp, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Eye, FileCode2, GitBranch, GitCompare, Sparkles, Wrench, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { SessionExecutionGraphStep } from '../../../runtime-host/shared/session-adapter-types';
import { supportsInlineDiff, type GeneratedFile } from '@/lib/generated-files';

interface ExecutionGraphCardProps {
  agentLabel: string;
  sessionLabel: string;
  steps: SessionExecutionGraphStep[];
  active: boolean;
  triggerItemKey?: string;
  replyItemKey?: string;
  onJumpToItemKey?: (itemKey?: string) => void;
  artifactFiles?: GeneratedFile[];
  onOpenArtifactFile?: (file: GeneratedFile) => void;
}

function GraphStatusIcon({ status }: { status: SessionExecutionGraphStep['status'] }) {
  if (status === 'completed') return <CheckCircle2 className="h-4 w-4" />;
  if (status === 'error') return <XCircle className="h-4 w-4" />;
  return <CircleDashed className="h-4 w-4" />;
}

function StepDetailCard({ step }: { step: SessionExecutionGraphStep }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const hasDetail = !!step.detail;
  const isFlatRow = step.kind === 'tool' || step.kind === 'system';
  const detailPreview = step.detail?.replace(/\s+/g, ' ').trim();
  const showStatusPill = !(isFlatRow && step.status === 'completed');

  return (
    <div
      className={cn(
        'min-w-0 flex-1',
        isFlatRow
          ? 'px-0 py-0'
          : 'rounded-[18px] border border-border/45 bg-background/68 px-3 py-2.5 shadow-sm backdrop-blur-sm',
      )}
    >
      <button
        type="button"
        className={cn(
          'flex w-full gap-2 text-left',
          isFlatRow ? 'items-center' : 'items-start',
          hasDetail ? 'cursor-pointer' : 'cursor-default',
        )}
        onClick={() => {
          if (!hasDetail) return;
          setExpanded((value) => !value);
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className={cn('text-sm font-medium text-foreground', isFlatRow && 'shrink-0')}>{step.label}</p>
            {isFlatRow && detailPreview && !expanded && (
              <p className="min-w-0 truncate text-[12px] leading-5 text-muted-foreground">
                {detailPreview}
              </p>
            )}
            {showStatusPill && (
              <span className="shrink-0 whitespace-nowrap rounded-full border border-border/40 bg-background/82 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t(`taskPanel.stepStatus.${step.status}`)}
              </span>
            )}
            {step.depth > 1 && (
              <span className="shrink-0 whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                {t('executionGraph.branchLabel')}
              </span>
            )}
          </div>
          {step.detail && !expanded && !isFlatRow && (
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground line-clamp-2">{step.detail}</p>
          )}
        </div>
        {hasDetail && (
          <span className="mt-0.5 shrink-0 text-muted-foreground">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </span>
        )}
      </button>
      {step.detail && expanded && (
        <div className="mt-3 rounded-[14px] border border-border/40 bg-background/74 px-3 py-2">
          <pre className="whitespace-pre-wrap break-words text-[12px] leading-5 text-muted-foreground">
            {step.detail}
          </pre>
        </div>
      )}
    </div>
  );
}

export const ExecutionGraphCard = memo(function ExecutionGraphCard({
  agentLabel,
  sessionLabel,
  steps,
  active,
  triggerItemKey,
  replyItemKey,
  onJumpToItemKey,
  artifactFiles = [],
  onOpenArtifactFile,
}: ExecutionGraphCardProps) {
  const { t } = useTranslation('chat');
  const handleJumpToTrigger = useCallback(() => {
    onJumpToItemKey?.(triggerItemKey);
  }, [onJumpToItemKey, triggerItemKey]);
  const handleJumpToReply = useCallback(() => {
    onJumpToItemKey?.(replyItemKey);
  }, [onJumpToItemKey, replyItemKey]);
  const handleOpenArtifactByPointer = useCallback((event: PointerEvent<HTMLButtonElement>, file: GeneratedFile) => {
    if (event.button !== 0) {
      return;
    }
    onOpenArtifactFile?.(file);
  }, [onOpenArtifactFile]);
  const handleOpenArtifactByMouseDown = useCallback((event: MouseEvent<HTMLButtonElement>, file: GeneratedFile) => {
    if (event.button !== 0) {
      return;
    }
    onOpenArtifactFile?.(file);
  }, [onOpenArtifactFile]);
  const handleOpenArtifactByClick = useCallback((event: MouseEvent<HTMLButtonElement>, file: GeneratedFile) => {
    if (event.detail !== 0) {
      return;
    }
    onOpenArtifactFile?.(file);
  }, [onOpenArtifactFile]);

  return (
    <div
      data-testid="chat-execution-graph"
      className="w-full rounded-[22px] border border-border/45 bg-background/62 px-4 py-4 shadow-[0_10px_30px_rgba(15,23,42,0.05)] backdrop-blur-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
            {t('executionGraph.eyebrow')}
          </p>
          <h3 className="mt-1 text-base font-semibold text-foreground">{t('executionGraph.title')}</h3>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {agentLabel} · {sessionLabel}
          </p>
        </div>
        <span
          className={cn(
            'rounded-full border px-2.5 py-1 text-[11px] font-medium',
            active ? 'border-primary/20 bg-primary/8 text-primary' : 'border-border/40 bg-background/78 text-foreground/70',
          )}
        >
          {active ? t('executionGraph.status.active') : t('executionGraph.status.previous')}
        </span>
      </div>

      <div className="mt-4 space-y-3">
        <button
          type="button"
          data-testid="chat-execution-jump-trigger"
          onClick={handleJumpToTrigger}
          className="flex items-center gap-2 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowUp className="h-3.5 w-3.5" />
          <span>{t('executionGraph.userTriggerHint')}</span>
        </button>

        <div className="pl-4">
          <div className="ml-4 h-4 w-px bg-border" />
        </div>

        <div className="flex gap-3">
          <div className="flex w-8 shrink-0 justify-center">
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-primary/15 bg-primary/8 text-primary">
              <Bot className="h-4 w-4" />
            </div>
          </div>
          <div className="min-w-0 flex-1 rounded-[18px] border border-primary/15 bg-primary/6 px-3 py-2.5 shadow-sm backdrop-blur-sm">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <GitBranch className="h-4 w-4 text-primary" />
              <span>{t('executionGraph.agentRun', { agent: agentLabel })}</span>
            </div>
          </div>
        </div>

        {steps.map((step, index) => (
          <div key={step.id}>
            <div className="pl-4" style={{ marginLeft: `${Math.max(step.depth - 1, 0) * 24}px` }}>
              <div className="ml-4 h-4 w-px bg-border" />
            </div>
            <div
              className="flex gap-3"
              data-testid="chat-execution-step"
              style={{ marginLeft: `${Math.max(step.depth - 1, 0) * 24}px` }}
            >
              <div className="flex w-8 shrink-0 justify-center">
                <div className="relative flex items-center justify-center">
                  {step.depth > 1 && (
                    <div className="absolute -left-4 top-1/2 h-px w-4 -translate-y-1/2 bg-border" />
                  )}
                  <div
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-full',
                      step.status === 'running' && 'bg-primary/10 text-primary',
                      step.status === 'completed' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                      step.status === 'error' && 'bg-destructive/10 text-destructive',
                    )}
                  >
                    {step.kind === 'thinking'
                      ? <Sparkles className="h-4 w-4" />
                      : step.kind === 'tool'
                        ? <Wrench className="h-4 w-4" />
                        : <GraphStatusIcon status={step.status} />}
                  </div>
                </div>
              </div>
              <StepDetailCard step={step} />
            </div>
            {index === steps.length - 1 && (
              <>
                <div className="pl-4">
                  <div className="ml-4 h-4 w-px bg-border" />
                </div>
                <button
                  type="button"
                  data-testid="chat-execution-jump-reply"
                  onClick={handleJumpToReply}
                  className="flex items-center gap-2 pl-11 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                  <span>{t('executionGraph.agentReplyHint')}</span>
                </button>
              </>
            )}
          </div>
        ))}

        {artifactFiles.length > 0 ? (
          <div className="rounded-[18px] border border-border/45 bg-background/60 px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <FileCode2 className="h-3.5 w-3.5" />
              <span>{t('executionGraph.generatedFiles', { count: artifactFiles.length })}</span>
            </div>
            <div className="space-y-2">
              {artifactFiles.map((file) => {
                const openAsDiff = file.sourceTool === 'edit' && supportsInlineDiff(file);
                return (
                  <button
                    key={file.toolId}
                    type="button"
                    data-testid={`execution-graph-artifact-${file.toolId}`}
                    onPointerDown={(event) => handleOpenArtifactByPointer(event, file)}
                    onMouseDown={(event) => handleOpenArtifactByMouseDown(event, file)}
                    onClick={(event) => handleOpenArtifactByClick(event, file)}
                    className="flex w-full items-center justify-between gap-3 rounded-[14px] border border-border/45 bg-background/78 px-3 py-2 text-left transition-colors hover:bg-muted/45"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{file.fileName}</p>
                      <p className="truncate text-[11px] text-muted-foreground">{file.filePath}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-[11px] text-muted-foreground">
                        +{file.lineStats.added} / -{file.lineStats.removed}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-background/82 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {openAsDiff ? <GitCompare className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        {openAsDiff ? t('executionGraph.openChanges') : t('executionGraph.openPreview')}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});
