import { Bot, Loader2, MessageSquare, Sparkles } from 'lucide-react';
import type { ApprovalDecision, ApprovalItem } from '@/stores/chat';
import { useTranslation } from 'react-i18next';

export function WelcomeScreen() {
  const { t } = useTranslation('chat');
  return (
    <div className="flex w-full max-w-3xl flex-col items-center justify-center px-4 pb-16 pt-16 text-center md:px-6 md:pt-24">
      <div className="mb-7 flex h-[72px] w-[72px] items-center justify-center rounded-[1.75rem] border border-border/55 bg-background/82 text-foreground shadow-[0_16px_44px_rgba(15,23,42,0.07)] backdrop-blur-sm">
        <Bot className="h-8 w-8" />
      </div>
      <h2 className="mb-2 text-[2.15rem] font-semibold tracking-[-0.05em] text-foreground">{t('welcome.title')}</h2>
      <p className="mb-9 max-w-xl text-[15px] leading-7 text-muted-foreground">
        {t('welcome.subtitle')}
      </p>

      <div className="mt-2 grid w-full gap-4 md:grid-cols-2">
        {[
          { icon: MessageSquare, title: t('welcome.askQuestions'), desc: t('welcome.askQuestionsDesc') },
          { icon: Sparkles, title: t('welcome.creativeTasks'), desc: t('welcome.creativeTasksDesc') },
        ].map((item, i) => (
          <div
            key={i}
            className="rounded-[1.5rem] border border-border/55 bg-background/78 px-5 py-5 text-left shadow-[0_10px_28px_rgba(15,23,42,0.045)] backdrop-blur-sm"
          >
            <item.icon className="mb-3 h-5 w-5 text-foreground" />
            <h3 className="font-medium text-foreground">{item.title}</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TypingIndicator() {
  return (
    <div className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/55 bg-background/82 text-foreground shadow-sm backdrop-blur-sm">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="w-fit rounded-[18px] border border-border/45 bg-background/78 px-4 py-3 shadow-sm backdrop-blur-sm">
        <div className="flex gap-1.5">
          <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/45" style={{ animationDelay: '0ms' }} />
          <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/45" style={{ animationDelay: '150ms' }} />
          <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/45" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
}

export function ActivityIndicator() {
  const label = 'Processing tool results...';
  return (
    <div className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/55 bg-background/82 text-foreground shadow-sm backdrop-blur-sm">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="w-fit rounded-[18px] border border-border/45 bg-background/78 px-4 py-3 shadow-sm backdrop-blur-sm">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>{label}</span>
        </div>
      </div>
    </div>
  );
}

export function ApprovalActionsPanel({
  approvals,
  onResolve,
}: {
  approvals: ApprovalItem[];
  onResolve: (id: string, decision: ApprovalDecision) => void;
}) {
  const { t } = useTranslation('chat');
  return (
    <div className="w-full rounded-[18px] border border-primary/15 bg-background/76 p-3 backdrop-blur-sm">
      <div className="mb-2 text-sm font-medium text-foreground">{t('approval.panelTitle')}</div>
      <div className="space-y-2">
        {approvals.map((approval) => (
          <div key={approval.id} className="rounded-[14px] border border-border/55 bg-background/72 p-2.5">
            <div className="mb-2 text-xs text-muted-foreground">
              {t('approval.pendingTool', { tool: approval.toolName || t('approval.unknownTool') })}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onResolve(approval.id, 'allow-once')}
                className="rounded-full border border-primary/20 bg-primary/8 px-3 py-1 text-xs font-medium text-primary transition hover:bg-primary/14"
              >
                {t('approval.allowOnce')}
              </button>
              <button
                type="button"
                onClick={() => onResolve(approval.id, 'allow-always')}
                className="rounded-full border border-primary/20 bg-primary/8 px-3 py-1 text-xs font-medium text-primary transition hover:bg-primary/14"
              >
                {t('approval.allowAlways')}
              </button>
              <button
                type="button"
                onClick={() => onResolve(approval.id, 'deny')}
                className="rounded-full border border-destructive/20 bg-destructive/8 px-3 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/14"
              >
                {t('approval.deny')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
