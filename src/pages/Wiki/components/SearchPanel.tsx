import { useMemo, type JSX, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FileSearch, Loader2, Search, TextSearch } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { WikiSearchResult } from '../wiki-model';
import { WikiEmpty, WikiPanel, WikiPanelHeader, WikiPrimaryButton } from './WikiChrome';
import { WikiSearchImages, type WikiSearchImageHit } from './WikiSearchImages';
import { WikiSearchText } from './WikiSearchText';

export type SearchPanelProps = Readonly<{
  query: string;
  searchResult: WikiSearchResult | null;
  contextResult: WikiSearchResult | null;
  busy: string | null;
  onQueryChange(value: string): void;
  onSearch(): void;
  onRetrieveContext(): void;
  onOpenResult(path: string): void;
  onOpenSource?(pagePath: string, imageSrc: string): Promise<void>;
}>;

type ResultListProps = Readonly<{
  title: string;
  result: WikiSearchResult | null;
  emptyText: string;
  loading: boolean;
  disabled: boolean;
  onOpenResult(path: string): void;
  onOpenSource?: SearchPanelProps['onOpenSource'];
}>;

const STOP_WORDS = new Set([
  '的', '是', '了', '什么', '在', '有', '和', '与', '对', '从',
  'the', 'is', 'a', 'an', 'what', 'how', 'are', 'was', 'were',
  'do', 'does', 'did', 'be', 'been', 'being', 'have', 'has', 'had',
  'it', 'its', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'this', 'that', 'these', 'those',
]);

function queryTokens(query: string): readonly string[] {
  const tokens: string[] = [];
  for (const token of query.toLowerCase().split(/[\s,，。！？、；："'（）()\-_/\\·~～…]+/)) {
    if (token.length <= 1 || STOP_WORDS.has(token)) continue;
    if (/[一-鿿㐀-䶿]/.test(token) && token.length > 2) {
      const chars = [...token];
      for (let index = 0; index < chars.length - 1; index++) tokens.push(chars[index] + chars[index + 1]);
      tokens.push(...chars.filter((char) => !STOP_WORDS.has(char)));
    }
    tokens.push(token);
  }
  return tokens.length > 0 ? [...new Set(tokens)].sort((left, right) => right.length - left.length) : query.trim() ? [query.trim().toLowerCase()] : [];
}

function formatScore(score: number): string {
  return score.toFixed(3);
}

function ResultList({ title, result, emptyText, loading, disabled, onOpenResult, onOpenSource }: ResultListProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const hits = result?.hits ?? [];
  const tokens = useMemo(() => queryTokens(result?.query ?? ''), [result?.query]);
  const images = useMemo(() => {
    const seen = new Set<string>();
    const imageHits: WikiSearchImageHit[] = [];
    for (const hit of result?.hits ?? []) {
      for (const image of hit.images) {
        if (seen.has(image.url)) continue;
        seen.add(image.url);
        imageHits.push({ ...image, sourcePath: hit.relativePath, sourceTitle: hit.title, matchesQuery: tokens.some((token) => image.alt.toLowerCase().includes(token)) });
      }
    }
    return imageHits.sort((left, right) => Number(right.matchesQuery) - Number(left.matchesQuery));
  }, [result, tokens]);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" aria-busy={loading}>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/70 px-5">
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="secondary">{hits.length}</Badge>
      </div>
      {loading ? <div role="status" className="flex items-center gap-2 px-5 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('search.searching', { defaultValue: '正在检索…' })}</div> : null}
      {result && hits.length > 0 ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-3 text-xs text-muted-foreground">
            <span>{t('search.mode', { defaultValue: '检索模式：{{mode}}', mode: result.mode })}</span>
            <span>{t('search.hitCounts', { defaultValue: '关键词 {{token}} · 向量 {{vector}} · 图谱 {{graph}}', token: result.tokenHits, vector: result.vectorHits, graph: result.graphHits })}</span>
          </div>
          {images.length > 0 ? <WikiSearchImages key={result.query} images={images} tokens={tokens} disabled={disabled} onOpenSource={onOpenSource} /> : null}
        </>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {result === null ? (
          <WikiEmpty title={emptyText} />
        ) : hits.length === 0 ? (
          <WikiEmpty title={t('search.noResults', { defaultValue: '没有找到匹配结果' })} />
        ) : (
          <div className="space-y-2">
            {hits.map((hit) => (
              <button
                key={hit.relativePath}
                type="button"
                disabled={disabled}
                onClick={() => onOpenResult(hit.relativePath)}
                className="w-full rounded-2xl border border-border/70 bg-card px-4 py-3 text-left hover:bg-secondary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium"><WikiSearchText text={hit.title} tokens={tokens} /></div>
                    <div className="truncate text-xs text-muted-foreground">{hit.relativePath}</div>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">{formatScore(hit.score)}</span>
                </div>
                {hit.snippets.map((snippet, index) => <p key={index} className="mt-2 line-clamp-2 text-sm text-muted-foreground"><WikiSearchText text={snippet} tokens={tokens} /></p>)}
                {hit.titleMatch || hit.vectorScore !== null || hit.graphRelatedTo.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {hit.titleMatch ? <span>{t('search.titleMatch', { defaultValue: '标题命中' })}</span> : null}
                    {hit.vectorScore !== null ? <span>{t('search.vectorScore', { defaultValue: '向量相似度 {{score}}', score: formatScore(hit.vectorScore) })}</span> : null}
                    {hit.graphRelatedTo.length > 0 ? <span>{t('search.graphRelated', { defaultValue: '图谱关联：{{pages}}', pages: hit.graphRelatedTo.join('、') })}</span> : null}
                  </div>
                ) : null}
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
  const { query, searchResult, contextResult, busy, onQueryChange, onSearch, onRetrieveContext, onOpenResult, onOpenSource } = props;
  const trimmedQuery = query.trim();
  const isBusy = busy !== null;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !isBusy && trimmedQuery) onSearch();
  };

  return (
    <WikiPanel>
      <WikiPanelHeader
        title={t('search.title', { defaultValue: '搜索' })}
        icon={Search}
        actions={(
          <>
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('search.placeholder', { defaultValue: '搜索知识库内容' })}
              aria-label={t('search.placeholder', { defaultValue: '搜索知识库内容' })}
              disabled={isBusy}
              className="h-9 w-[min(48vw,680px)] rounded-full bg-card"
            />
            <WikiPrimaryButton size="sm" onClick={onSearch} disabled={isBusy || !trimmedQuery}>
              {busy === 'search' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4" />}
              {t('search.action', { defaultValue: '搜索' })}
            </WikiPrimaryButton>
            <Button size="sm" variant="outline" onClick={onRetrieveContext} disabled={isBusy || !trimmedQuery} className="h-8 rounded-full bg-card">
              {busy === 'context' ? <Loader2 className="h-4 w-4 animate-spin" /> : <TextSearch className="h-4 w-4" />}
              {t('search.contextAction', { defaultValue: '检索上下文' })}
            </Button>
          </>
        )}
      />
      <div className="grid min-h-0 flex-1 grid-rows-2 lg:grid-cols-2 lg:grid-rows-1">
        <ResultList title={t('search.results', { defaultValue: '搜索结果' })} result={searchResult} emptyText={t('search.noResults', { defaultValue: '没有找到匹配结果' })} loading={busy === 'search'} disabled={isBusy} onOpenResult={onOpenResult} onOpenSource={onOpenSource} />
        <div className="min-h-0 border-t border-border/70 lg:border-l lg:border-t-0">
          <ResultList title={t('search.context', { defaultValue: '检索上下文' })} result={contextResult} emptyText={t('search.noContext', { defaultValue: '尚未检索上下文' })} loading={busy === 'context'} disabled={isBusy} onOpenResult={onOpenResult} onOpenSource={onOpenSource} />
        </div>
      </div>
    </WikiPanel>
  );
}
