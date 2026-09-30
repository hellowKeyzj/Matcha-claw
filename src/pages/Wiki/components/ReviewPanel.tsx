import { type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, CheckCircle2, Copy, FileQuestion, Lightbulb, MessageSquare, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { WikiReviewItem } from '../wiki-model';
import { formatDateTime } from '../wiki-model';
import { isResearchReviewAction } from '../research-model';
import { WikiEmpty, WikiIconButton, WikiPanel, WikiPanelHeader, WikiSurface } from './WikiChrome';

export type ReviewPanelProps = Readonly<{
  items: readonly WikiReviewItem[];
  busy: string | null;
  onRefresh(): void;
  onResolve(id: string, action: string): void;
  onDismiss(id: string): void;
  onClearResolved(): void;
  onCreatePage(item: WikiReviewItem): void;
  onResearch(item: WikiReviewItem): void;
}>;

type ReviewTypeConfig = Readonly<{ icon: typeof AlertTriangle; className: string }>;

const TYPE_CONFIG: Record<WikiReviewItem['type'], ReviewTypeConfig> = {
  contradiction: { icon: AlertTriangle, className: 'text-amber-500' },
  duplicate: { icon: Copy, className: 'text-blue-500' },
  'missing-page': { icon: FileQuestion, className: 'text-purple-500' },
  confirm: { icon: MessageSquare, className: 'text-foreground' },
  suggestion: { icon: Lightbulb, className: 'text-emerald-500' },
};

export function ReviewPanel(props: ReviewPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const { items, busy, onRefresh, onResolve, onDismiss, onClearResolved, onCreatePage, onResearch } = props;
  const pending = items.filter((item) => !item.resolved);
  const resolved = items.filter((item) => item.resolved);
  const isBusy = busy !== null;

  return (
    <WikiPanel>
      <WikiPanelHeader
        title={t('review.title')}
        subtitle={t('review.subtitle', { pending: pending.length, resolved: resolved.length })}
        icon={FileQuestion}
        actions={(
          <>
            <Button size="sm" variant="outline" onClick={onClearResolved} disabled={isBusy || resolved.length === 0} className="h-8 rounded-full bg-card">
              <CheckCircle2 className="h-4 w-4" />
              {t('review.clearResolved')}
            </Button>
            <WikiIconButton onClick={onRefresh} disabled={isBusy} title={t('common.refresh')}>
              <RefreshCw className="h-4 w-4" />
            </WikiIconButton>
          </>
        )}
      />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {items.length > 0 ? (
          <div className="space-y-3">
            {items.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                busy={isBusy}
                onResolve={onResolve}
                onDismiss={onDismiss}
                onCreatePage={onCreatePage}
                onResearch={onResearch}
              />
            ))}
          </div>
        ) : (
          <WikiEmpty title={t('review.empty')} icon={FileQuestion} />
        )}
      </div>
    </WikiPanel>
  );
}

function ReviewCard(props: Readonly<{
  item: WikiReviewItem;
  busy: boolean;
  onResolve(id: string, action: string): void;
  onDismiss(id: string): void;
  onCreatePage(item: WikiReviewItem): void;
  onResearch(item: WikiReviewItem): void;
}>): JSX.Element {
  const { t } = useTranslation('wiki');
  const { item, busy, onResolve, onDismiss, onCreatePage, onResearch } = props;
  const config = TYPE_CONFIG[item.type];
  const Icon = config.icon;
  const createAction = item.options.find((option) => !isResearchReviewAction(option.action) && (option.action === 'Create Page' || option.label === 'Create Page'));
  const otherOptions = item.options.filter((option) => option !== createAction);

  return (
    <WikiSurface className="p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary">
          <Icon className={`h-4 w-4 ${config.className}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={item.resolved ? 'success' : 'warning'}>{item.resolved ? t('review.resolved') : t('review.pending')}</Badge>
            <Badge variant="outline">{t(`review.types.${item.type}`)}</Badge>
            {item.sourcePath ? <span className="truncate text-xs text-muted-foreground">{item.sourcePath}</span> : null}
            <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(item.createdAt, '')}</span>
          </div>
          <h3 className="mt-2 text-sm font-semibold">{item.title}</h3>
          {item.description ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{item.description}</p> : null}
          <ReviewMeta label={t('review.pages')} values={item.affectedPages} />
          <ReviewMeta label={t('review.search')} values={item.searchQueries} />
          {item.resolvedAction ? <div className="mt-2 text-xs text-muted-foreground">{item.resolvedAction}</div> : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {item.type === 'suggestion' || item.type === 'missing-page' ? (
          <Button size="sm" onClick={() => onResearch(item)} disabled={busy || item.resolved} className="h-8 rounded-full">
            <Search className="h-4 w-4" />
            {t('research.title', { defaultValue: '深度研究' })}
          </Button>
        ) : null}
        {createAction ? (
          <Button size="sm" onClick={() => onCreatePage(item)} disabled={busy || item.resolved} className="h-8 rounded-full">
            <FileQuestion className="h-4 w-4" />
            {createAction.label}
          </Button>
        ) : null}
        {otherOptions.map((option) => (
          <Button key={option.action} size="sm" variant="outline" onClick={() => isResearchReviewAction(option.action) ? onResearch(item) : onResolve(item.id, option.action)} disabled={busy || item.resolved} className="h-8 rounded-full bg-card">
            <Check className="h-4 w-4" />
            {option.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => onResolve(item.id, 'Resolved')} disabled={busy || item.resolved} className="h-8 rounded-full">
          <Check className="h-4 w-4" />
          {t('review.resolve')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onDismiss(item.id)} disabled={busy} className="h-8 rounded-full">
          <Trash2 className="h-4 w-4" />
          {t('review.dismiss')}
        </Button>
      </div>
    </WikiSurface>
  );
}

function ReviewMeta(props: Readonly<{ label: string; values: readonly string[] }>): JSX.Element | null {
  if (props.values.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
      <span>{props.label}</span>
      {props.values.map((value) => <Badge key={value} variant="secondary">{value}</Badge>)}
    </div>
  );
}
