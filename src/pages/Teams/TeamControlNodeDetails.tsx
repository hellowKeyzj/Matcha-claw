import { ArrowRight, GitMerge, TriangleAlert } from 'lucide-react';
import type { TeamGraphEdgeRecord } from '@/types/team-design';
import type { TeamControlNodeDetailsProps } from './team-node-editor-types';

export function TeamControlNodeDetails({ kind, node, nodes, edges, labels }: TeamControlNodeDetailsProps) {
  if (kind === 'end') {
    return <p className="text-sm leading-relaxed text-muted-foreground">{labels.endConfigurationHint}</p>;
  }

  const nodesById = new Map(nodes.map((item) => [item.nodeId, item]));
  const nodeTitle = (nodeId: string) => nodesById.get(nodeId)?.title?.trim() || nodeId;
  const portLabel = (port: string | undefined) => port
    ? labels.portLabels[port] ?? port
    : labels.invalidPort.replace('{{port}}', '∅');
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
    <div className="space-y-5">
      {kind === 'human_decision' ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{labels.humanDecisionHint}</p>
      ) : null}
      {kind === 'join' ? (
        <section className="space-y-3" aria-label={labels.nodeIncomingConnections}>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <GitMerge aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            {labels.nodeIncomingConnections}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">{labels.joinConfigurationHint}</p>
          {incoming.length ? (
            <ul className="divide-y divide-border/60">
              {incoming.map((edge) => (
                <li key={edge.edgeId} className="space-y-1 py-3 first:pt-0 last:pb-0">
                  <p className="break-words text-sm [overflow-wrap:anywhere]">{nodeTitle(edge.sourceNodeId)}</p>
                  <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {labels.edgeTriggerCondition} · {portLabel(edge.sourcePort)}
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
            <p className="text-sm text-muted-foreground">{labels.nodeNoConnections}</p>
          )}
        </section>
      ) : null}
      <section className="space-y-3" aria-label={labels.nodeOutgoingConnections}>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          {labels.nodeOutgoingConnections}
        </h3>
        {outgoing.size ? (
          <dl className="divide-y divide-border/60">
            {[...outgoing].map(([port, connections]) => (
              <div key={port} className="grid gap-1.5 py-3 first:pt-0 last:pb-0">
                <dt className="break-words text-xs font-medium text-muted-foreground [overflow-wrap:anywhere]">{portLabel(port)}</dt>
                <dd className="min-w-0">
                  {connections.length ? (
                    <ul className="space-y-2">
                      {connections.map((edge) => (
                        <li key={edge.edgeId} className="break-words text-sm [overflow-wrap:anywhere]">
                          {nodeTitle(edge.targetNodeId)}
                          {edge.action ? <span className="mt-0.5 block text-xs text-muted-foreground">{labels.edgeActionOptions[edge.action]}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">{labels.nodeNoConnections}</p>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{labels.nodeNoConnections}</p>
        )}
      </section>
    </div>
  );
}
