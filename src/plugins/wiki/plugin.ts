import { createElement, lazy } from 'react';
import { BookOpen, FileText, FolderOpen, GitGraph, ListChecks, MessageSquare, Search, ShieldQuestion, Wrench } from 'lucide-react';
import { WikiNavigationIcon } from '@/components/icons/navigation';
import { applicationNavigation, applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { chatComposerActions, type ChatComposerPanelProps } from '@/plugins/chat/extensions';
import { wikiContentPreviews, wikiSourceActions, wikiWorkspaceTabs } from './extensions';

const WikiPage = lazyWithPreload(() => import('./index'));
const ProjectPicker = lazyWithPreload<ChatComposerPanelProps>(() => import('./components/ProjectPicker').then((module) => ({ default: module.ProjectPicker })));
const WikiContentPanel = lazy(() => import('./components/WikiContentPanel').then((module) => ({ default: module.WikiContentPanel })));
const SourcesPanel = lazy(() => import('./components/SourcesPanel').then((module) => ({ default: module.SourcesPanel })));
const ReviewPanel = lazy(() => import('./components/ReviewPanel').then((module) => ({ default: module.ReviewPanel })));
const QuestionPanel = lazy(() => import('./components/QuestionPanel').then((module) => ({ default: module.QuestionPanel })));
const LintPanel = lazy(() => import('./components/LintPanel').then((module) => ({ default: module.LintPanel })));
const MaintenancePanel = lazy(() => import('./components/MaintenancePanel').then((module) => ({ default: module.MaintenancePanel })));
const SearchPanel = lazy(() => import('./components/SearchPanel').then((module) => ({ default: module.SearchPanel })));
const GraphWorkspacePanel = lazy(() => import('./components/GraphWorkspacePanel'));
const SourcePreview = lazy(() => import('./components/content-previews').then((module) => ({ default: module.SourcePreview })));
const ImagePreview = lazy(() => import('./components/content-previews').then((module) => ({ default: module.ImagePreview })));
const PdfPreview = lazy(() => import('./components/content-previews').then((module) => ({ default: module.PdfPreview })));
const AudioPreview = lazy(() => import('./components/content-previews').then((module) => ({ default: module.AudioPreview })));
const VideoPreview = lazy(() => import('./components/content-previews').then((module) => ({ default: module.VideoPreview })));
const MarkdownPreview = lazy(() => import('./components/content-previews').then((module) => ({ default: module.MarkdownPreview })));
const HtmlPreview = lazy(() => import('./components/content-previews').then((module) => ({ default: module.HtmlPreview })));
const TextPreview = lazy(() => import('./components/content-previews').then((module) => ({ default: module.TextPreview })));

export const wikiPlugin = definePlugin({
  id: 'wiki',
  requires: ['app-shell', 'chat'],
  extensionPoints: [wikiWorkspaceTabs, wikiSourceActions, wikiContentPreviews],
  contributes: [
    contribute(applicationPages, { id: 'wiki', path: '/wiki', component: WikiPage, viewport: 'workspace', preload: WikiPage.preload }),
    contribute(applicationNavigation, { id: 'wiki', to: '/wiki', label: 'Wiki', icon: WikiNavigationIcon, order: 60, prefetch: WikiPage.preload }),
    contribute(chatComposerActions, {
      id: 'wiki', order: 20, icon: BookOpen, control: 'wiki', panel: ProjectPicker,
      resolve: ({ t }) => ({ label: t('input.pickWiki') }),
      execute: ({ openPanel }) => openPanel('wiki'),
    }),
    contribute(wikiWorkspaceTabs, {
      id: 'wiki', labelKey: 'workspace.tabs.wiki', icon: BookOpen,
      render: ({ wiki }) => createElement(WikiContentPanel, { ...wiki, key: JSON.stringify([wiki.projectId, wiki.selectedPath]) }),
    }),
    contribute(wikiWorkspaceTabs, {
      id: 'sources', labelKey: 'workspace.tabs.sources', icon: FileText,
      render: ({ sources }) => createElement(SourcesPanel, sources),
    }),
    contribute(wikiWorkspaceTabs, {
      id: 'review', labelKey: 'workspace.tabs.review', icon: ShieldQuestion,
      render: ({ review }) => createElement(ReviewPanel, review),
    }),
    contribute(wikiWorkspaceTabs, {
      id: 'qa', labelKey: 'workspace.tabs.qa', defaultValue: '问答', icon: MessageSquare, keepMounted: true,
      render: ({ qa }) => createElement(QuestionPanel, { ...qa, key: qa.projectId }),
    }),
    contribute(wikiWorkspaceTabs, {
      id: 'lint', labelKey: 'workspace.tabs.lint', defaultValue: '检查', icon: ListChecks,
      render: ({ lint }) => createElement(LintPanel, { ...lint, key: lint.projectId }),
    }),
    contribute(wikiWorkspaceTabs, {
      id: 'search', labelKey: 'workspace.tabs.search', icon: Search,
      render: ({ search }) => createElement(SearchPanel, search),
    }),
    contribute(wikiWorkspaceTabs, {
      id: 'graph', labelKey: 'workspace.tabs.graph', icon: GitGraph,
      render: ({ graph }) => createElement(GraphWorkspacePanel, { ...graph, key: graph.projectId }),
    }),
    contribute(wikiWorkspaceTabs, {
      id: 'maintenance', labelKey: 'workspace.tabs.maintenance', defaultValue: '维护', icon: Wrench,
      render: ({ maintenance }) => createElement(MaintenancePanel, { ...maintenance, key: maintenance.projectId }),
    }),
    contribute(wikiSourceActions, { id: 'import-source', labelKey: 'sources.importFile', busyLabelKey: 'sourceProgress.importingFile', icon: FileText, primary: true, execute: async (context) => (await import('./source-actions')).pickAndImportSource(context) }),
    contribute(wikiSourceActions, { id: 'import-folder', labelKey: 'sources.folder', busyLabelKey: 'sourceProgress.importingFolder', icon: FolderOpen, execute: async (context) => (await import('./source-actions')).pickAndImportFolder(context) }),
    contribute(wikiSourceActions, { id: 'rescan', labelKey: 'sources.scanSources', icon: Search, execute: async (context) => (await import('./source-actions')).rescanSources(context) }),
    contribute(wikiContentPreviews, { id: 'source', matches: (preview) => preview.kind === 'source', component: SourcePreview }),
    contribute(wikiContentPreviews, { id: 'image', matches: (preview) => preview.kind === 'binary' && preview.contentType === 'image', component: ImagePreview }),
    contribute(wikiContentPreviews, { id: 'pdf', matches: (preview) => preview.kind === 'binary' && preview.contentType === 'pdf', component: PdfPreview }),
    contribute(wikiContentPreviews, { id: 'audio', matches: (preview) => preview.kind === 'binary' && preview.contentType === 'audio', component: AudioPreview }),
    contribute(wikiContentPreviews, { id: 'video', matches: (preview) => preview.kind === 'binary' && preview.contentType === 'video', component: VideoPreview }),
    contribute(wikiContentPreviews, { id: 'markdown', matches: (preview) => preview.kind === 'text' && preview.contentType === 'markdown', component: MarkdownPreview }),
    contribute(wikiContentPreviews, { id: 'html', matches: (preview) => preview.kind === 'text' && preview.contentType === 'html', component: HtmlPreview }),
    contribute(wikiContentPreviews, { id: 'text', matches: (preview) => preview.kind === 'text', component: TextPreview }),
  ],
});
