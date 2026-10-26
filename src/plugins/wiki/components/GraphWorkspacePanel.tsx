import type { JSX } from 'react';
import type { WikiWorkspacePanels } from '../extensions';
import { GraphPanel } from './GraphPanel';
import { GraphInsightsPanel } from './GraphInsightsPanel';

export default function GraphWorkspacePanel({ projectId, onLocateNodes, ...graph }: WikiWorkspacePanels['graph']): JSX.Element {
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(320px,1fr)_minmax(240px,1fr)] xl:grid-cols-[minmax(0,1fr)_360px] xl:grid-rows-1">
      <GraphPanel key={projectId} {...graph} />
      <div className="min-h-0 overflow-auto border-t xl:border-l xl:border-t-0"><GraphInsightsPanel key={projectId} projectId={projectId} busy={graph.busy} onLocateNodes={onLocateNodes} /></div>
    </div>
  );
}
