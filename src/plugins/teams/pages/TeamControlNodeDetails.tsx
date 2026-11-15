import { ArrowRight, GitMerge, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TeamGraphEdgeRecord } from '@/types/team-design';
import type { TeamControlNodeDetailsProps } from '@/plugins/teams/pages/team-node-editor-types';

export function TeamControlNodeDetails({ kind, node, nodes, edges, labels }: TeamControlNodeDetailsProps) {
  const { t } = useTranslation('teams');
  if (kind === 'end') {
    return <p className="text-xs leading-relaxed text-muted-foreground">{labels.endConfigurationHint}</p>;
  }

  const nodesById = new Map(nodes.map((item) => [item.nodeId, item]));
  const nodeTitle = (nodeId: string) => nodesById.get(nodeId)?.title?.trim() || nodeId;
  const portLabel = (port: string | undefined, sourceKind: string | undefined) => port === 'completed' && sourceKind === 'review'
    ? t('workspace.reviewPassed')
    : port ? labels.portLabels[port] ?? port : labels.invalidPort.replace('{{port}}', '∅');
  const incoming = kind === 'join' ? edges.filter((edge) => edge.targetNodeId === node.nodeId) : [];
  const outgoing = new Map<string, TeamGraphEdgeRecord[]>((node.sourcePorts ?? []).map((port) => [port, []]));
  for (const edge of edges) {
    if (edge.sourceNodeId !== node.nodeId) continue;
    const port = edge.sourcePort ?? '';
    const branch = outgoing.get(port);
    if (branch) branch.push(edge);
    else outgoing.set(port, [edge]);
  }

  return (
    <div className="space-y-[25px] max-[780px]:space-y-[22px]">
      {kind === 'join' ? (
        <section className="space-y-3" aria-label={labels.nodeIncomingConnections}>
          <h3 className="flex items-center gap-2 text-xs font-medium">
            <GitMerge aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            {labels.nodeIncomingConnections}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">{labels.joinConfigurationHint}</p>
          {incoming.length ? (
            <ul className="divide-y divide-border/60">
              {incoming.map((edge) => (
                <li key={edge.edgeId} className="space-y-1 py-3 first:pt-0 last:pb-0">
                  <p className="break-words text-xs [overflow-wrap:anywhere]">{nodeTitle(edge.sourceNodeId)}</p>
                  <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {labels.edgeTriggerCondition} · {portLabel(edge.sourcePort, nodesById.get(edge.sourceNodeId)?.kind)}
                  </p>
                  {edge.action !== 'gate' ? (
                    <p className="flex items-start gap-1.5 text-xs text-destructive">
                      <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="break-words [overflow-wrap:anywhere]">
                        {labels.invalidEdgeAction.replace('{{action}}', edge.action ? labels.edgeActionOptions[edge.action] : '∅')}
                      </span>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{labels.nodeNoConnections}</p>
          )}
        </section>
      ) : null}
      <section className="space-y-3" aria-label={labels.nodeOutgoingConnections}>
        <h3 className="flex items-center gap-2 text-xs font-medium">
          <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          {labels.nodeOutgoingConnections}
        </h3>
        {outgoing.size ? (
          <dl className="divide-y divide-[hsl(var(--shell-border))]">
            {[...outgoing].map(([port, connections]) => (
              <div key={port} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-3 py-3 first:pt-0 last:pb-0">
                <dt className="min-w-0 break-words text-xs font-medium leading-relaxed [overflow-wrap:anywhere]">{portLabel(port, kind)}</dt>
                <dd className="min-w-0">
                  {connections.length ? (
                    <ul className="space-y-2">
                      {connections.map((edge) => (
                        <li key={edge.edgeId} className="flex min-w-0 items-start gap-2 text-xs leading-relaxed">
                          <ArrowRight aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                            {edge.action === 'rework' || edge.action === 'gate' ? (
                              <span className="mr-1 text-muted-foreground">{t(`run.graphCanvas.nodeTransitionActions.${edge.action}`)}</span>
                            ) : !edge.action ? (
                              <span className="mr-1 text-destructive">{labels.invalidEdgeAction.replace('{{action}}', '∅')}</span>
                            ) : null}
                            {nodeTitle(edge.targetNodeId)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="flex min-w-0 items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                      <ArrowRight aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{labels.nodeNoConnections}</span>
                    </p>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">{labels.nodeNoConnections}</p>
        )}
      </section>
    </div>
  );
}
