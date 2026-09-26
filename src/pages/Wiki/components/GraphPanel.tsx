import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Network, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WikiGraphResult } from '../wiki-model';
import { WikiEmpty, WikiPanel, WikiPanelHeader, WikiPrimaryButton } from './WikiChrome';

export type GraphPanelProps = Readonly<{
  graph: WikiGraphResult | null;
  selectedPath: string;
  busy: string | null;
  onLoadGraph(): void;
  onEmbedPage(): void;
  onOpenNode(path: string): void;
}>;

function EmptyGraph(): JSX.Element {
  const { t } = useTranslation('wiki');
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-center">
      <WikiEmpty title={t('graph.empty')} icon={Network} className="px-12 py-10" />
    </div>
  );
}

export function GraphPanel(props: GraphPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const { graph, selectedPath, busy, onLoadGraph, onEmbedPage, onOpenNode } = props;
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const isBusy = busy !== null;

  return (
    <WikiPanel>
      <WikiPanelHeader
        title={t('graph.title')}
        subtitle={t('graph.subtitle', { nodes: nodes.length, edges: edges.length })}
        icon={Network}
        actions={(
          <>
            <WikiPrimaryButton size="sm" onClick={onLoadGraph} disabled={isBusy}>
              <GitBranch className="h-4 w-4" />
              {t('graph.load')}
            </WikiPrimaryButton>
            <Button size="sm" variant="outline" onClick={onEmbedPage} disabled={isBusy || !selectedPath.trim()} className="h-8 rounded-full bg-card">
              <Sparkles className="h-4 w-4" />
              {t('graph.embed')}
            </Button>
          </>
        )}
      />

      {graph === null ? (
        <EmptyGraph />
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-2">
          <section className="min-w-0 overflow-auto p-5">
            <div className="mb-3 text-sm font-medium">{t('graph.nodes')}</div>
            {nodes.length === 0 ? <WikiEmpty title={t('graph.emptyNodes')} /> : null}
            <div className="space-y-2">
              {nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onOpenNode(node.id)}
                  className={cn('w-full rounded-2xl border border-border/70 bg-card px-4 py-3 text-left hover:bg-secondary/35', node.id === selectedPath && 'border-primary/30 bg-primary/5')}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.label}</span>
                    <Badge variant={node.id === selectedPath ? 'default' : 'outline'}>{node.kind}</Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{node.id}</div>
                </button>
              ))}
            </div>
          </section>

          <section className="min-w-0 overflow-auto border-l border-border/70 p-5">
            <div className="mb-3 text-sm font-medium">{t('graph.edges')}</div>
            {edges.length === 0 ? <WikiEmpty title={t('graph.emptyEdges')} /> : null}
            <div className="space-y-2">
              {edges.map((edge, index) => (
                <div key={`${edge.source}:${edge.target}:${edge.label}:${index}`} className="rounded-2xl border border-border/70 bg-card px-4 py-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 truncate">{edge.source}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="min-w-0 truncate">{edge.target}</span>
                  </div>
                  <Badge className="mt-2" variant="secondary">{edge.label}</Badge>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </WikiPanel>
  );
}
