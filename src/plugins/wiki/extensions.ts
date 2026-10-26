import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { WikiReceiptSummary } from './wiki-model';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { WikiContentPanelProps, WikiContentPreview } from './components/WikiContentPanel';
import type { SourcesPanelProps } from './components/SourcesPanel';
import type { ReviewPanelProps } from './components/ReviewPanel';
import type { QuestionPanelProps } from './components/QuestionPanel';
import type { LintPanelProps } from './components/LintPanel';
import type { MaintenancePanelProps } from './components/MaintenancePanel';
import type { SearchPanelProps } from './components/SearchPanel';
import type { GraphPanelProps } from './components/GraphPanel';
import type { GraphInsightsPanelProps } from './components/GraphInsightsPanel';

export type WikiWorkspacePanels = Readonly<{
  wiki: WikiContentPanelProps;
  sources: SourcesPanelProps;
  review: ReviewPanelProps;
  qa: QuestionPanelProps;
  lint: LintPanelProps;
  maintenance: MaintenancePanelProps;
  search: SearchPanelProps;
  graph: GraphPanelProps & Pick<GraphInsightsPanelProps, 'projectId' | 'onLocateNodes'>;
}>;

export type WikiWorkspaceTabContribution = Readonly<{
  id: string;
  labelKey: string;
  defaultValue?: string;
  icon: LucideIcon;
  keepMounted?: boolean;
  render(panels: WikiWorkspacePanels): ReactNode;
}>;

export type WikiSourceMutationOptions = Readonly<{
  label: string;
  projectBound?: boolean;
  observeTasks?: boolean;
  success?: string;
}>;

export type WikiSourceActionContext = Readonly<{
  projectId: string;
  t: TFunction<'wiki'>;
  mutate(options: WikiSourceMutationOptions, task: () => Promise<WikiReceiptSummary | void>): Promise<void>;
}>;

export type WikiSourceActionContribution = Readonly<{
  id: string;
  labelKey: string;
  busyLabelKey?: string;
  icon: LucideIcon;
  primary?: boolean;
  execute(context: WikiSourceActionContext): Promise<void>;
}>;

export type WikiContentPreviewProps = Readonly<{
  preview: WikiContentPreview;
  editorText: string;
  editing: boolean;
  resolveImageSrc?: WikiContentPanelProps['resolveImageSrc'];
  onEditorTextChange(value: string): void;
  onEditorSelection(markdown: string, start: number, end: number): void;
  onTextSelection(selection: Selection | null, root: HTMLDivElement): void;
}>;

export type WikiContentPreviewContribution = Readonly<{
  id: string;
  matches(preview: WikiContentPreview): boolean;
  component: ComponentType<WikiContentPreviewProps>;
}>;

export const wikiWorkspaceTabs = defineExtensionPoint<WikiWorkspaceTabContribution>('wiki.workspace.tabs');
export const wikiSourceActions = defineExtensionPoint<WikiSourceActionContribution>('wiki.source.actions');
export const wikiContentPreviews = defineExtensionPoint<WikiContentPreviewContribution>('wiki.content.previews');
