import type { JSX, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FileSearch, Search, TextSearch } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { WikiSearchResult } from '../wiki-model';
import { WikiEmpty, WikiPanel, WikiPanelHeader, WikiPrimaryButton } from './WikiChrome';

export type SearchPanelProps = Readonly<{
  query: string;
  searchResult: WikiSearchResult | null;
  contextResult: WikiSearchResult | null;
  busy: string | null;
  onQueryChange(value: string): void;
  onSearch(): void;
  onRetrieveContext(): void;
  onOpenResult(path: string): void;
}>;

type ResultListProps = Readonly<{
  title: string;
  result: WikiSearchResult | null;
  emptyText: string;
  onOpenResult(path: string): void;
}>;

function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(3) : '0.000';
}

function ResultList({ title, result, emptyText, onOpenResult }: ResultListProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const hits = result?.hits ?? [];

  return (
    <section className="flex min-w-0 flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/70 px-5">
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="secondary">{hits.length}</Badge>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {result === null ? (
          <WikiEmpty title={emptyText} />
        ) : hits.length === 0 ? (
          <WikiEmpty title={t('search.noResults')} />
        ) : (
          <div className="space-y-2">
            {hits.map((hit) => (
              <button
                key={hit.relativePath}
                type="button"
                onClick={() => onOpenResult(hit.relativePath)}
                className="w-full rounded-2xl border border-border/70 bg-card px-4 py-3 text-left hover:bg-secondary/35"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{hit.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{hit.relativePath}</div>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">{formatScore(hit.score)}</span>
                </div>
                {hit.snippets.length > 0 ? <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{hit.snippets[0]}</p> : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function SearchPanel(props: SearchPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const { query, searchResult, contextResult, busy, onQueryChange, onSearch, onRetrieveContext, onOpenResult } = props;
  const trimmedQuery = query.trim();
  const isBusy = busy !== null;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') onSearch();
  };

  return (
    <WikiPanel>
      <WikiPanelHeader
        title={t('search.title')}
        icon={Search}
        actions={(
          <>
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('search.placeholder')}
              disabled={isBusy}
              className="h-9 w-[min(48vw,680px)] rounded-full bg-card"
            />
            <WikiPrimaryButton size="sm" onClick={onSearch} disabled={isBusy || !trimmedQuery}>
              <FileSearch className="h-4 w-4" />
              {t('search.action')}
            </WikiPrimaryButton>
            <Button size="sm" variant="outline" onClick={onRetrieveContext} disabled={isBusy || !trimmedQuery} className="h-8 rounded-full bg-card">
              <TextSearch className="h-4 w-4" />
              {t('search.contextAction')}
            </Button>
          </>
        )}
      />
      <div className="grid min-h-0 flex-1 lg:grid-cols-2">
        <ResultList title={t('search.results')} result={searchResult} emptyText={t('search.noResults')} onOpenResult={onOpenResult} />
        <div className="min-h-0 border-l border-border/70">
          <ResultList title={t('search.context')} result={contextResult} emptyText={t('search.noContext')} onOpenResult={onOpenResult} />
        </div>
      </div>
    </WikiPanel>
  );
}
