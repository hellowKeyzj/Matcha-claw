import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3, BookOpen, ChevronDown, ChevronRight, FileText, GitMerge, Globe,
  HelpCircle, Layout, Lightbulb, Target, Trash2, TrendingUp, Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { WikiNavigationPage } from '@/types/wiki-navigation';
import type { WikiFileItem } from '../wiki-model';

export type KnowledgeTreePanelProps = Readonly<{
  pages: readonly WikiNavigationPage[];
  sourceFiles: readonly WikiFileItem[];
  selectedPath: string;
  busy: string | null;
  loading: boolean;
  error: string | null;
  onSelectFile(path: string): void;
  onDeletePage(path: string): Promise<void>;
  onRetry(): void;
}>;

const PAGE_TYPES = [
  { type: 'overview', icon: Layout },
  { type: 'entity', icon: Users },
  { type: 'concept', icon: Lightbulb },
  { type: 'source', icon: BookOpen },
  { type: 'synthesis', icon: GitMerge },
  { type: 'finding', icon: TrendingUp },
  { type: 'thesis', icon: Target },
  { type: 'methodology', icon: BookOpen },
  { type: 'comparison', icon: BarChart3 },
  { type: 'query', icon: HelpCircle },
] as const;
const NATURAL_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const HIDDEN_SOURCE_NAMES = new Set(['.cache', '.DS_Store']);
const SENSITIVE_CONFIG_DIRECTORIES = new Set(['.claude', '.codex', '.cursor', '.gemini', '.mcp']);
const SENSITIVE_CONFIG_EXTENSIONS = new Set(['env', 'json', 'toml', 'yaml', 'yml', 'xml']);
const ROW_CLASS = 'h-8 w-full justify-start gap-1.5 rounded-md px-2 text-left text-sm';
const ICON_CLASS = 'h-3.5 w-3.5 shrink-0 text-[hsl(var(--shell-icon))]';

function normalizeSourceIdentity(source: string): string {
  return source.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^raw\/sources\//i, '').toLowerCase();
}

function semanticTypeLabel(type: string): string {
  return type.split(/[-_\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function sourceFileName(file: WikiFileItem): string {
  return file.path.replace(/\\/g, '/').split('/').pop() ?? file.label;
}

function naturalCompare(left: string, right: string): number {
  return NATURAL_ORDER.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}

function compareSourcePaths(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] === right[index]) continue;
    const leftDirectory = index < left.length - 1;
    const rightDirectory = index < right.length - 1;
    return Number(rightDirectory) - Number(leftDirectory) || naturalCompare(left[index], right[index]);
  }
  return left.length - right.length;
}

function isVisibleRawSource(file: WikiFileItem): boolean {
  if (file.isDirectory) return false;
  const path = file.path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path.startsWith('raw/sources/')) return false;
  const parts = path.split('/');
  if (parts.some((part) => HIDDEN_SOURCE_NAMES.has(part))) return false;
  const name = parts[parts.length - 1];
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : '';
  return !(extension && SENSITIVE_CONFIG_EXTENSIONS.has(extension)
    && parts.some((part) => SENSITIVE_CONFIG_DIRECTORIES.has(part.toLowerCase())));
}

export function KnowledgeTreePanel({
  pages, sourceFiles, selectedPath, busy, loading, error, onSelectFile, onDeletePage, onRetry,
}: KnowledgeTreePanelProps): ReactElement {
  const { t } = useTranslation('wiki');
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [expandedTypes, setExpandedTypes] = useState<ReadonlySet<string>>(() => new Set(['overview', 'entity', 'concept', 'source']));
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [armedPath, setArmedPath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const sourceOptions = useMemo(() => {
    const identities = new Map<string, string>();
    for (const page of pages) {
      for (const source of page.sources) {
        const identity = normalizeSourceIdentity(source);
        if (identity && !identities.has(identity)) identities.set(identity, source.trim());
      }
    }
    return [...identities].sort((left, right) => NATURAL_ORDER.compare(left[1], right[1]));
  }, [pages]);
  const hasSelectedSource = selectedSource !== null && sourceOptions.some(([identity]) => identity === selectedSource);
  if (!loading && error === null && selectedSource !== null && !hasSelectedSource) setSelectedSource(null);
  const sourceFilter = hasSelectedSource ? selectedSource : null;

  const groups = useMemo(() => {
    const grouped = new Map<string, WikiNavigationPage[]>();
    for (const page of pages) {
      if (sourceFilter && !page.sources.some((source) => normalizeSourceIdentity(source) === sourceFilter)) continue;
      const items = grouped.get(page.type) ?? [];
      items.push(page);
      grouped.set(page.type, items);
    }
    return [...grouped].sort(([left], [right]) => {
      const leftOrder = PAGE_TYPES.findIndex((config) => config.type === left);
      const rightOrder = PAGE_TYPES.findIndex((config) => config.type === right);
      return (leftOrder < 0 ? 99 : leftOrder) - (rightOrder < 0 ? 99 : rightOrder)
        || semanticTypeLabel(left).localeCompare(semanticTypeLabel(right));
    });
  }, [pages, sourceFilter]);

  const rawSources = useMemo(() => sourceFiles.filter(isVisibleRawSource)
    .map((file) => ({ file, segments: file.path.replace(/\\/g, '/').replace(/^\.\//, '').split('/') }))
    .sort((left, right) => compareSourcePaths(left.segments, right.segments))
    .map(({ file }) => file), [sourceFiles]);
  const disabled = busy !== null || loading || error !== null || deletingPath !== null;

  function toggleType(type: string): void {
    setExpandedTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function deletePage(page: WikiNavigationPage): Promise<void> {
    if (disabled) return;
    if (armedPath !== page.path) {
      setArmedPath(page.path);
      return;
    }
    setArmedPath(null);
    setDeletingPath(page.path);
    try {
      await onDeletePage(page.path);
      if (mounted.current) toast.success(t('sidebar.deleted'));
    } catch (cause) {
      if (mounted.current) toast.error(cause instanceof Error ? cause.message : t('sidebar.deleteFailed'));
    } finally {
      if (mounted.current) {
        setArmedPath(null);
        setDeletingPath(null);
      }
    }
  }

  return (
    <nav aria-label={t('sidebar.knowledge')} aria-busy={loading} className="space-y-1">
      <h3 className="px-2 py-1.5 text-xs font-semibold text-[hsl(var(--shell-text-muted))]">{t('sidebar.knowledge')}</h3>
      {loading ? (
        <p role="status" className="px-2 py-4 text-xs text-[hsl(var(--shell-text-muted))]">{t('sidebar.loading')}</p>
      ) : error !== null ? (
        <div className="space-y-2 px-2 py-3">
          <p role="alert" className="text-xs text-destructive">{t('sidebar.loadFailed')}</p>
          <p className="break-words text-xs text-[hsl(var(--shell-text-muted))]">{error}</p>
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={onRetry}>{t('sidebar.retry')}</Button>
        </div>
      ) : (
        <>
          {sourceOptions.length > 1 ? (
            <div className="px-2 pb-2">
              <Select
                aria-label={t('sidebar.filterBySource')}
                value={sourceFilter ?? ''}
                disabled={busy !== null || deletingPath !== null}
                onChange={(event) => { setSelectedSource(event.target.value || null); setArmedPath(null); }}
                className="h-8 rounded-md px-2 pr-8 text-xs"
              >
                <option value="">{t('sidebar.allSources')}</option>
                {sourceOptions.map(([identity, label]) => <option key={identity} value={identity}>{label}</option>)}
              </Select>
            </div>
          ) : null}
          {groups.length === 0 ? <p className="px-2 py-4 text-center text-xs text-[hsl(var(--shell-text-muted))]">{t('sidebar.noWikiPages')}</p> : null}
          {groups.map(([type, items]) => {
            const config = PAGE_TYPES.find((candidate) => candidate.type === type);
            const Icon = config?.icon ?? FileText;
            const expanded = expandedTypes.has(type);
            const label = config || type === 'other' ? t(`sidebar.typeLabels.${type}`) : semanticTypeLabel(type);
            return (
              <div key={type}>
                <Button type="button" variant="ghost" className={ROW_CLASS} aria-expanded={expanded} onClick={() => toggleType(type)}>
                  {expanded ? <ChevronDown className={ICON_CLASS} /> : <ChevronRight className={ICON_CLASS} />}
                  <Icon className={ICON_CLASS} />
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{label}</span>
                  <span className="text-xs text-[hsl(var(--shell-text-muted))]">{items.length}</span>
                </Button>
                {expanded ? (
                  <div className="ml-3">
                    {items.map((page) => {
                      const selected = selectedPath === page.path;
                      const armed = armedPath === page.path;
                      const deleting = deletingPath === page.path;
                      const deleteLabel = deleting ? t('sidebar.deleting') : t(armed ? 'sidebar.confirmDelete' : 'sidebar.deletePage', { title: page.title });
                      return (
                        <div key={page.path} className={cn('group flex min-w-0 items-center rounded-md hover:bg-[hsl(var(--shell-surface-hover))]', selected && 'bg-[hsl(var(--shell-surface-active))]')}>
                          <Button
                            type="button"
                            variant="ghost"
                            className={cn(ROW_CLASS, 'min-w-0 flex-1', selected && 'text-foreground')}
                            disabled={disabled}
                            aria-current={selected ? 'page' : undefined}
                            title={page.path}
                            onClick={() => { setArmedPath(null); onSelectFile(page.path); }}
                          >
                            {page.origin === 'web-clip' ? <Globe className={ICON_CLASS} /> : null}
                            <span className="truncate">{page.title}</span>
                          </Button>
                          <Button
                            type="button"
                            variant={armed ? 'destructive' : 'ghost'}
                            size={armed ? 'sm' : 'icon'}
                            disabled={disabled}
                            aria-label={deleteLabel}
                            title={deleteLabel}
                            className={cn(
                              'mr-1 h-8 shrink-0 rounded-md', armed ? 'px-2 text-xs' : 'w-8 hover:text-destructive',
                              !armed && !deleting && '[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
                            )}
                            onClick={() => { void deletePage(page); }}
                          >
                            <Trash2 className="h-3.5 w-3.5 shrink-0" />
                            {armed ? t('sidebar.confirm') : null}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </>
      )}
      {rawSources.length > 0 ? (
        <section className="mt-2 border-t pt-2 [border-color:hsl(var(--shell-border))]" aria-label={t('sidebar.rawSources')}>
          <Button type="button" variant="ghost" className={ROW_CLASS} aria-expanded={sourcesExpanded} onClick={() => setSourcesExpanded((expanded) => !expanded)}>
            {sourcesExpanded ? <ChevronDown className={ICON_CLASS} /> : <ChevronRight className={ICON_CLASS} />}
            <BookOpen className={ICON_CLASS} />
            <span className="min-w-0 flex-1 truncate font-medium">{t('sidebar.rawSources')}</span>
            <span className="text-xs text-[hsl(var(--shell-text-muted))]">{rawSources.length}</span>
          </Button>
          {sourcesExpanded ? (
            <div className="ml-3">
              {rawSources.map((file) => (
                <Button
                  key={file.path}
                  type="button"
                  variant="ghost"
                  className={cn(ROW_CLASS, selectedPath === file.path && 'bg-[hsl(var(--shell-surface-active))] text-foreground')}
                  disabled={busy !== null || deletingPath !== null}
                  aria-current={selectedPath === file.path ? 'page' : undefined}
                  title={file.path}
                  onClick={() => { setArmedPath(null); onSelectFile(file.path); }}
                >
                  <span className="truncate">{sourceFileName(file)}</span>
                </Button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </nav>
  );
}
