import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { pickLocalDirectory, pickLocalFile } from '@/services/local-path-picker';
import { openArtifactPathExternally } from '@/components/file-preview/open-file-utils';
import type { WikiNavigationPage } from '@/types/wiki-navigation';
import type { WikiSelectionApplyReceipt, WikiSelectionSnapshot } from '@/types/wiki-selection';
import { normalizeEditableMarkdown } from '@/lib/wiki-selection';
import { waitForCall } from '@/lib/call-log-await';
import { useWikiProjectsStore } from '@/stores/wiki-projects';
import { LibraryHome } from './components/LibraryHome';
import { LibraryWorkspace } from './components/LibraryWorkspace';
import { ActivityBar } from './components/ActivityBar';
import { isActiveSourceTask } from './wiki-model';
import { GraphPanel } from './components/GraphPanel';
import { GraphInsightsPanel } from './components/GraphInsightsPanel';
import { LintPanel } from './components/LintPanel';
import { MaintenancePanel } from './components/MaintenancePanel';
import { QuestionPanel } from './components/QuestionPanel';
import { SearchPanel } from './components/SearchPanel';
import { SourcesPanel } from './components/SourcesPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { WikiContentPanel, type WikiContentPreview } from './components/WikiContentPanel';
import { classifyWikiPath, isUnsupportedWikiSourcePreview, supportsWikiBinaryPreview, supportsWikiTextPreview, wikiPreviewErrorKey } from './preview';
import { resolveWikiMarkdownImage } from './wiki-media';
import { readOriginalImageSource } from './wiki-source-navigation';
import {
  hostWikiCancelSourceTask,
  hostWikiCallResult,
  hostWikiDeleteSource,
  hostWikiDeletePage,
  hostWikiNavigation,
  hostWikiEmbedPage,
  hostWikiFiles,
  hostWikiGraph,
  hostWikiImportFolder,
  hostWikiImportSource,
  hostWikiProjectTemplates,
  hostWikiReadBinaryFile,
  hostWikiReadFile,
  hostWikiReadSourcePreview,
  hostWikiRefreshSources,
  hostWikiRescanSources,
  hostWikiRetrieveContext,
  hostWikiReviews,
  hostWikiResolveReview,
  hostWikiDismissReview,
  hostWikiClearResolvedReviews,
  hostWikiSearch,
  hostWikiSourceFiles,
  hostWikiSourceTasks,
  hostWikiSourceWatchConfig,
  hostWikiStatus,
  hostWikiUpdateSourceWatchConfig,
  hostWikiWriteFile,
} from '@/lib/host-api';
import {
  normalizeFiles,
  normalizeGraph,
  normalizeProjectTemplates,
  normalizeRead,
  normalizeReviews,
  normalizeSearch,
  normalizeSourceTasks,
  normalizeSourceWatchConfig,
  normalizeStatus,
  summarizeDeleteSourceResult,
  summarizeSourceCallCounts,
  type WikiFileItem,
  type WikiGraphResult,
  type WikiProject,
  type WikiProjectTemplate,
  type WikiReceiptSummary,
  type WikiReviewItem,
  type WikiSearchResult,
  type WikiSourceTask,
  type WikiSourceView,
  type WikiSourceWatchConfig,
  type WikiSourceWatchConfigUpdate,
  type WikiStatus,
  type WikiWorkspaceTab,
} from './wiki-model';

type WikiPageMode = 'home' | 'workspace';

const EMPTY_STATUS: WikiStatus = {
  stateRoot: '',
  currentProject: null,
  projectCount: 0,
  pendingChangeCount: 0,
};

const DEFAULT_SOURCE_WATCH_CONFIG: WikiSourceWatchConfig = {
  enabled: false,
  autoIngest: false,
  outputLanguage: 'auto',
  generationModelRef: '',
  captionModelRef: '',
  captionEnabled: false,
  captionConcurrency: 4,
  mineruEnabled: false,
  mineruBackend: 'cloud',
  mineruTokenConfigured: false,
  mineruModelVersion: 'vlm',
  mineruLocalEndpoint: 'http://127.0.0.1:8000',
  mineruLocalTokenConfigured: false,
  mineruLocalBackend: 'hybrid-engine',
  mineruLocalEffort: 'medium',
  mineruLocalParseMethod: 'auto',
  mineruLocalLanguage: 'ch',
  mineruLocalFormulaEnabled: true,
  mineruLocalTableEnabled: true,
  mineruLocalImageAnalysis: true,
  mineruLocalServerUrl: '',
};

const WIKI_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

type ReviewPageType = 'entity' | 'concept' | 'comparison' | 'synthesis' | 'query';

type ReviewPageDraft = Readonly<{
  title: string;
  pageType: ReviewPageType;
  dir: string;
}>;

const ACTION_PREFIX_RE = /^(Create|Save|Add|Missing page|Missing pages|缺失页面|缺少页面|创建|保存|新增)[:：\s-]*/i;
const ENTITY_RE = /\b(entity|entities)\b|实体/i;
const CONCEPT_RE = /\b(concept|concepts)\b|概念/i;

function compareFileItems(left: WikiFileItem, right: WikiFileItem): number {
  return Number(right.isDirectory) - Number(left.isDirectory) || left.path.localeCompare(right.path);
}

function mergeFileItems(existing: readonly WikiFileItem[], incoming: readonly WikiFileItem[]): readonly WikiFileItem[] {
  const byPath = new Map(existing.map((item) => [item.path, item]));
  for (const item of incoming) byPath.set(item.path, item);
  return [...byPath.values()].sort(compareFileItems);
}

function makeQuerySlug(title: string): string {
  const slug = title
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const truncated = Array.from(slug).slice(0, 50).join('');
  return truncated.length > 0 ? truncated : 'query';
}

function makeQueryFileName(title: string, now = new Date()): { fileName: string; date: string } {
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19).replace(/:/g, '');
  return { date, fileName: `${makeQuerySlug(title)}-${date}-${time}.md` };
}

function cleanCandidateTitle(value: string): string {
  return value
    .replace(ACTION_PREFIX_RE, '')
    .replace(/^(missing|缺失|缺少)\s*/i, '')
    .replace(/\s*(page|pages|页面|页)\s*$/i, '')
    .replace(/\s*(entity|entities|concept|concepts|实体|概念)\s*(page|pages|页面|页)?\s*$/i, '')
    .replace(/^[\s"'“”‘’`[\]【】()（）]+|[\s"'“”‘’`[\]【】()（）:：.。]+$/g, '')
    .trim();
}

function splitCandidateList(value: string): string[] {
  return value
    .replace(/\band\b/gi, ',')
    .replace(/\s+和\s+/g, ',')
    .split(/[,，、;；\n]+/)
    .map(cleanCandidateTitle)
    .filter((title) => title.length > 0);
}

function extractMissingPageCandidates(text: string): string[] {
  const candidates: string[] = [];
  const segments = text.split(/[\n。]+/).map((segment) => segment.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const segment of segments) {
    const colonTail = segment.match(/[:：]\s*(.+)$/)?.[1];
    if (colonTail) candidates.push(...splitCandidateList(colonTail));
    const chineseMissing = segment.match(/(?:缺少|缺失|未创建|没有)\s*([^；;]+?)(?:等)?\s*(?:实体|概念)?\s*(?:页面|页)(?:缺失|不存在|未创建)?/i);
    if (chineseMissing?.[1]) candidates.push(...splitCandidateList(chineseMissing[1]));
    const englishMissing = segment.match(/missing\s+(?:entity|entities|concept|concepts|page|pages)?\s*([^.;]+?)(?:\s+pages?|\s+entities?|\s+concepts?)?$/i);
    if (englishMissing?.[1]) candidates.push(...splitCandidateList(englishMissing[1]));
  }
  if (candidates.length === 0) candidates.push(cleanCandidateTitle(segments[0] ?? '') || 'Untitled');
  return Array.from(new Set(candidates));
}

function detectReviewPageType(action: string, reviewType: WikiReviewItem['type'], text: string): ReviewPageType {
  const combined = `${action}\n${text}`;
  if (ENTITY_RE.test(combined)) return 'entity';
  if (CONCEPT_RE.test(combined)) return 'concept';
  if (/comparison|compare|比较/i.test(combined)) return 'comparison';
  if (/synthesis|综合/i.test(combined)) return 'synthesis';
  if (reviewType === 'missing-page') return 'concept';
  return 'query';
}

function reviewPageDir(pageType: ReviewPageType): string {
  return pageType === 'entity' ? 'entities' : pageType === 'concept' ? 'concepts' : pageType === 'comparison' ? 'comparisons' : pageType === 'synthesis' ? 'synthesis' : 'queries';
}

function createReviewPageDrafts(item: WikiReviewItem, action: string): ReviewPageDraft[] {
  const text = `${item.title}\n${item.description}`;
  const pageType = detectReviewPageType(action, item.type, text);
  const titles = item.type === 'missing-page' ? extractMissingPageCandidates(text) : [cleanCandidateTitle(item.title) || 'Untitled'];
  return titles.map((title) => ({ title, pageType, dir: reviewPageDir(pageType) }));
}

function visibleFileItems(payload: unknown): readonly WikiFileItem[] {
  return normalizeFiles(payload).filter((item) => !item.path.replace(/\\/g, '/').split('/').some((segment) => segment.startsWith('.')));
}

function replaceDirectoryItems(existing: readonly WikiFileItem[], directory: string, incoming: readonly WikiFileItem[]): readonly WikiFileItem[] {
  const prefix = directory ? `${directory}/` : '';
  const children = new Map(incoming.map((item) => [item.path, item]));
  const retained = existing.filter((item) => {
    if (!item.path.startsWith(prefix) || item.path === directory) return true;
    const childPath = `${prefix}${item.path.slice(prefix.length).split('/')[0]}`;
    const child = children.get(childPath);
    return child !== undefined && (item.path === childPath || child.isDirectory);
  });
  return mergeFileItems(retained, incoming);
}

export default function WikiPage() {
  const { t } = useTranslation('wiki');
  const [pageMode, setPageMode] = useState<WikiPageMode>('home');
  const [status, setStatus] = useState<WikiStatus>(EMPTY_STATUS);
  const projects = useWikiProjectsStore((state) => state.projects);
  const currentProject = useWikiProjectsStore((state) => state.currentProject);
  const projectSwitching = useWikiProjectsStore((state) => state.switching);
  const refreshProjects = useWikiProjectsStore((state) => state.refresh);
  const openProject = useWikiProjectsStore((state) => state.openProject);
  const createProject = useWikiProjectsStore((state) => state.createProject);
  const [projectTemplates, setProjectTemplates] = useState<readonly WikiProjectTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('general');
  const [files, setFiles] = useState<readonly WikiFileItem[]>([]);
  const [sourceFiles, setSourceFiles] = useState<readonly WikiFileItem[]>([]);
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(() => new Set());
  const [loadedDirectories, setLoadedDirectories] = useState<ReadonlySet<string>>(() => new Set());
  const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(() => new Set());
  const [directoryErrors, setDirectoryErrors] = useState<Readonly<Record<string, string>>>({});
  const [navigationPages, setNavigationPages] = useState<readonly WikiNavigationPage[]>([]);
  const [navigationLoading, setNavigationLoading] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const projectId = currentProject?.projectId;
  const [sourceTaskProjection, setSourceTaskProjection] = useState<Readonly<{ projectId: string; tasks: readonly WikiSourceTask[] }> | null>(null);
  const sourceTasks = useMemo(() => sourceTaskProjection && sourceTaskProjection.projectId === projectId ? sourceTaskProjection.tasks : [], [projectId, sourceTaskProjection]);
  const [sourceTasksError, setSourceTasksError] = useState<string | null>(null);
  const [cancellingSourceTasks, setCancellingSourceTasks] = useState<ReadonlySet<string>>(() => new Set());
  const cancellingSourceTasksRef = useRef(new Set<string>());
  const sourceTaskReadRef = useRef<Readonly<{ projectId: string; generation: number; promise: Promise<boolean> }> | null>(null);
  const sourceTaskRevisionRef = useRef(0);
  const [sourceWatchConfig, setSourceWatchConfig] = useState<WikiSourceWatchConfig>(DEFAULT_SOURCE_WATCH_CONFIG);
  const [reviewItems, setReviewItems] = useState<readonly WikiReviewItem[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [preview, setPreview] = useState<WikiContentPreview>({ kind: 'empty' });
  const [sourceImageIndex, setSourceImageIndex] = useState<number | undefined>();
  const [editorText, setEditorText] = useState('');
  const [openPath, setOpenPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [lastReceipt, setLastReceipt] = useState<WikiReceiptSummary | null>(null);
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<WikiSearchResult | null>(null);
  const [contextResult, setContextResult] = useState<WikiSearchResult | null>(null);
  const [graph, setGraph] = useState<WikiGraphResult | null>(null);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<readonly string[]>([]);
  const [questionProjectId, setQuestionProjectId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WikiWorkspaceTab>('wiki');
  const [sourceView, setSourceView] = useState<WikiSourceView>('sources');
  const [actionBusy, setBusy] = useState<string | null>('load');
  const [sourceImportBusy, setSourceImportBusy] = useState<string | null>(null);
  const sourceImportBusyRef = useRef<string | null>(null);
  const busy = sourceImportBusy ?? actionBusy;
  const projectIdRef = useRef(projectId);
  const selectedPathRef = useRef(selectedPath);
  const editorTextRef = useRef(editorText);
  editorTextRef.current = editorText;
  const fileRequestRef = useRef(0);
  const snapshotRequestRef = useRef(0);
  const snapshotReadingRef = useRef(false);
  const treeRequestRef = useRef({ projectId, files: [] as readonly WikiFileItem[], loaded: new Set<string>(), loading: new Set<string>() });
  const projectGenerationRef = useRef(0);
  const navigationRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const projectGeneration = projectGenerationRef.current;
  const cancellingSourcePaths = useMemo(() => new Set(sourceTasks.filter((task) => cancellingSourceTasks.has(JSON.stringify([projectId, task.sourcePath]))).map((task) => task.sourcePath)), [cancellingSourceTasks, projectId, sourceTasks]);
  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);
  useEffect(() => { selectedPathRef.current = selectedPath; }, [selectedPath]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; fileRequestRef.current++; snapshotRequestRef.current++; navigationRequestRef.current++; projectGenerationRef.current++; };
  }, []);

  const run = useCallback(async (label: string, task: () => Promise<void>, success?: string) => {
    const importing = ['import-source', 'import-folder', 'refresh-sources'].includes(label);
    if (importing && sourceImportBusyRef.current) return;
    const generation = projectGenerationRef.current;
    if (importing) {
      sourceImportBusyRef.current = label;
      setSourceImportBusy(label);
      setSourceTasksError(null);
    } else setBusy(label);
    try {
      await task();
      if (success && (!importing || generation === projectGenerationRef.current)) toast.success(success);
    } catch (error) {
      if (!importing || generation === projectGenerationRef.current) toast.error(error instanceof Error ? error.message : t('actions.failed', { label }));
    } finally {
      if (importing) {
        sourceImportBusyRef.current = null;
        if (mountedRef.current) setSourceImportBusy(null);
      } else setBusy(null);
    }
  }, [t]);

  const readSourceTasks = useCallback(async (selectedProjectId: string): Promise<boolean> => {
    const generation = projectGenerationRef.current;
    const isCurrent = () => generation === projectGenerationRef.current
      && projectIdRef.current === selectedProjectId
      && useWikiProjectsStore.getState().currentProject?.projectId === selectedProjectId
      && !useWikiProjectsStore.getState().switching;
    while (sourceTaskReadRef.current) {
      const previous = sourceTaskReadRef.current;
      if (previous.projectId === selectedProjectId && previous.generation === generation) return previous.promise;
      await previous.promise;
    }
    if (!isCurrent()) return false;
    const revision = sourceTaskRevisionRef.current;
    const promise = (async () => {
      try {
        const tasks = normalizeSourceTasks(await hostWikiSourceTasks({ projectId: selectedProjectId }));
        if (!isCurrent() || revision !== sourceTaskRevisionRef.current) return false;
        setSourceTaskProjection({ projectId: selectedProjectId, tasks });
        setSourceTasksError(null);
        return true;
      } catch {
        if (isCurrent() && revision === sourceTaskRevisionRef.current) setSourceTasksError(t('sourceProgress.readFailed'));
        return false;
      }
    })();
    const reading = { projectId: selectedProjectId, generation, promise };
    sourceTaskReadRef.current = reading;
    try {
      return await promise;
    } finally {
      if (sourceTaskReadRef.current === reading) sourceTaskReadRef.current = null;
    }
  }, [t]);

  const observeSourceTasks = sourceImportBusy !== null || sourceTasks.some(isActiveSourceTask);
  useEffect(() => {
    if (!projectId || projectSwitching || !observeSourceTasks || sourceTasksError) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await readSourceTasks(projectId);
      if (!stopped) timer = setTimeout(() => { void poll(); }, 1000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [observeSourceTasks, projectId, projectSwitching, readSourceTasks, sourceTasksError]);

  useEffect(() => { setSourceTasksError(null); }, [projectId]);

  const loadDirectory = useCallback(async (directory: string, tree = treeRequestRef.current): Promise<void> => {
    if (!tree.projectId || tree !== treeRequestRef.current || tree.loaded.has(directory) || tree.loading.has(directory)) return;
    tree.loading.add(directory);
    setLoadingDirectories(new Set(tree.loading));
    setDirectoryErrors((current) => { const next = { ...current }; delete next[directory]; return next; });
    try {
      const children = visibleFileItems(await hostWikiFiles({ projectId: tree.projectId, directory }));
      if (tree !== treeRequestRef.current || projectIdRef.current !== tree.projectId) return;
      const previousRoots = new Set(tree.files.filter((item) => item.isDirectory && !item.path.includes('/')).map((item) => item.path));
      tree.files = replaceDirectoryItems(tree.files, directory, children);
      tree.loaded.add(directory);
      const directoryPaths = new Set(tree.files.filter((item) => item.isDirectory).map((item) => item.path));
      tree.loaded = new Set([...tree.loaded].filter((path) => path === '' || directoryPaths.has(path)));
      setFiles(tree.files);
      setLoadedDirectories(new Set(tree.loaded));
      if (directory === '') {
        const roots = children.filter((item) => item.isDirectory).map((item) => item.path);
        setExpandedDirectories((current) => new Set([...current].filter((path) => directoryPaths.has(path)).concat(roots.filter((path) => !previousRoots.has(path)))));
        for (const path of roots) tree.loaded.delete(path);
        setLoadedDirectories(new Set(tree.loaded));
        await Promise.all(roots.map((path) => loadDirectory(path, tree)));
      }
    } catch (cause) {
      if (tree === treeRequestRef.current && projectIdRef.current === tree.projectId) {
        tree.files = tree.files.filter((item) => directory !== '' && !item.path.startsWith(`${directory}/`));
        tree.loaded = new Set([...tree.loaded].filter((path) => directory !== '' && path !== directory && !path.startsWith(`${directory}/`)));
        setFiles(tree.files);
        setLoadedDirectories(new Set(tree.loaded));
        setDirectoryErrors((current) => ({ ...current, [directory]: cause instanceof Error ? cause.message : t('sidebar.loadFailed') }));
      }
    } finally {
      if (tree === treeRequestRef.current) {
        tree.loading.delete(directory);
        setLoadingDirectories(new Set(tree.loading));
      }
    }
  }, [t]);

  const loadNavigation = useCallback(async (selectedProjectId: string): Promise<void> => {
    const request = ++navigationRequestRef.current;
    const generation = projectGenerationRef.current;
    const snapshot = snapshotRequestRef.current;
    const isCurrent = () => request === navigationRequestRef.current && generation === projectGenerationRef.current && snapshot === snapshotRequestRef.current && projectIdRef.current === selectedProjectId;
    setNavigationLoading(true);
    setNavigationError(null);
    setNavigationPages([]);
    setSourceFiles([]);
    const [navigation, sources] = await Promise.allSettled([
      hostWikiNavigation({ projectId: selectedProjectId }),
      hostWikiSourceFiles({ projectId: selectedProjectId }),
    ]);
    if (!isCurrent()) return;
    const errors: string[] = [];
    if (navigation.status === 'fulfilled' && navigation.value.projectId === selectedProjectId) setNavigationPages(navigation.value.pages);
    else errors.push(navigation.status === 'rejected' && navigation.reason instanceof Error ? navigation.reason.message : t('sidebar.loadFailed'));
    if (sources.status === 'fulfilled') setSourceFiles(mergeFileItems([], normalizeFiles(sources.value)));
    else errors.push(sources.reason instanceof Error ? sources.reason.message : t('sidebar.loadFailed'));
    setNavigationError(errors.length ? errors.join('\n') : null);
    setNavigationLoading(false);
  }, [t]);

  const loadWikiSnapshot = useCallback(async (expectedProjectId?: string) => {
    if (expectedProjectId && projectIdRef.current !== expectedProjectId) return;
    const request = ++snapshotRequestRef.current;
    snapshotReadingRef.current = true;
    navigationRequestRef.current++;
    const previousTree = treeRequestRef.current;
    treeRequestRef.current = { ...previousTree, loaded: new Set(previousTree.loaded), loading: new Set() };
    setLoadingDirectories(new Set(['']));
    setDirectoryErrors({});
    setNavigationPages([]);
    setSourceFiles([]);
    setNavigationLoading(true);
    setNavigationError(null);
    const [statusResult, projectsResult, templatesResult] = await Promise.allSettled([
      hostWikiStatus(),
      refreshProjects(),
      hostWikiProjectTemplates(),
    ]);

    if (request !== snapshotRequestRef.current) return;
    snapshotReadingRef.current = false;
    if (statusResult.status === 'rejected' || projectsResult.status === 'rejected') {
      setNavigationLoading(false);
      setNavigationError(t('sidebar.loadFailed'));
      setLoadingDirectories(new Set());
      setDirectoryErrors({ '': t('sidebar.loadFailed') });
      treeRequestRef.current.files = [];
      treeRequestRef.current.loaded.clear();
      setFiles([]);
      setLoadedDirectories(new Set());
      throw new Error(t('sidebar.loadFailed'));
    }
    const nextStatus = normalizeStatus(statusResult.value);
    const nextTemplates = templatesResult.status === 'fulfilled' ? normalizeProjectTemplates(templatesResult.value) : [];
    const nextCurrentProject = useWikiProjectsStore.getState().currentProject;

    const nextProjectId = nextCurrentProject?.projectId;
    if (request !== snapshotRequestRef.current || (expectedProjectId && (projectIdRef.current !== expectedProjectId || nextProjectId !== expectedProjectId))) return;
    const projectChanged = previousTree.projectId !== nextProjectId;
    const tree = {
      projectId: nextProjectId,
      files: projectChanged ? [] : previousTree.files,
      loaded: projectChanged ? new Set<string>() : new Set(previousTree.loaded),
      loading: new Set<string>(),
    };
    tree.loaded.delete('');
    treeRequestRef.current = tree;
    if (projectChanged) {
      projectGenerationRef.current++;
      setFiles([]);
      setLoadedDirectories(new Set());
      setExpandedDirectories(new Set());
    }
    if (projectChanged) {
      projectIdRef.current = nextCurrentProject?.projectId;
      fileRequestRef.current++;
      selectedPathRef.current = '';
      setQuestionProjectId(null);
      setGraph(null);
      setHighlightedNodeIds([]);
      setSearchResult(null);
      setContextResult(null);
      setSelectedPath('');
      setSourceImageIndex(undefined);
      setPreview({ kind: 'empty' });
      setEditorText('');
    }
    setStatus(nextStatus);
    setProjectTemplates(nextTemplates);
    const [sourceWatchResult, , reviewsResult] = await Promise.allSettled([
      nextProjectId ? hostWikiSourceWatchConfig({ projectId: nextProjectId }) : Promise.resolve({ config: DEFAULT_SOURCE_WATCH_CONFIG }),
      nextProjectId ? readSourceTasks(nextProjectId) : Promise.resolve(),
      nextProjectId ? hostWikiReviews({ projectId: nextProjectId }) : Promise.resolve([]),
      nextProjectId ? loadDirectory('', tree) : Promise.resolve(),
      nextProjectId ? loadNavigation(nextProjectId) : Promise.resolve(),
    ]);
    if (request !== snapshotRequestRef.current || projectIdRef.current !== nextProjectId || (expectedProjectId && projectIdRef.current !== expectedProjectId)) return;
    setSourceWatchConfig(sourceWatchResult.status === 'fulfilled' ? normalizeSourceWatchConfig(sourceWatchResult.value.config) : DEFAULT_SOURCE_WATCH_CONFIG);
    if (!nextProjectId) setSourceTaskProjection(null);
    setReviewItems(reviewsResult.status === 'fulfilled' ? normalizeReviews(reviewsResult.value) : []);

    if (!nextCurrentProject) {
      setPageMode('home');
      setFiles([]);
      setLoadedDirectories(new Set());
      setLoadingDirectories(new Set());
      setNavigationLoading(false);
      setSelectedPath('');
      setSourceFiles([]);
      setReviewItems([]);
      setPreview({ kind: 'empty' });
      setEditorText('');
    }
  }, [loadDirectory, loadNavigation, readSourceTasks, refreshProjects, t]);

  const refresh = useCallback(async () => {
    await run('load', () => loadWikiSnapshot());
  }, [loadWikiSnapshot, run]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!snapshotReadingRef.current && treeRequestRef.current.projectId !== projectId) void refresh();
  }, [projectId, refresh]);

  const chooseLibraryDirectory = useCallback(async () => {
    const path = await pickLocalDirectory({
      title: t('actions.pickLibraryTitle'),
      defaultPath: openPath || undefined,
      buttonLabel: t('actions.useFolder'),
    });
    if (path) setOpenPath(path);
  }, [openPath, t]);

  const createLibrary = useCallback(async () => {
    const path = openPath.trim();
    if (!path) return;
    await run('create', async () => {
      fileRequestRef.current++;
      snapshotRequestRef.current++;
      navigationRequestRef.current++;
      projectGenerationRef.current++;
      treeRequestRef.current = { ...treeRequestRef.current, loading: new Set() };
      snapshotReadingRef.current = true;
      try {
        await createProject({ path, name: projectName.trim() || undefined, templateId: selectedTemplateId });
        await loadWikiSnapshot();
        setPageMode('workspace');
      } finally {
        snapshotReadingRef.current = false;
      }
    }, t('actions.createdLibrary'));
  }, [createProject, loadWikiSnapshot, openPath, projectName, run, selectedTemplateId, t]);

  const selectProject = useCallback(async (project: WikiProject) => {
    await run('open', async () => {
      fileRequestRef.current++;
      snapshotRequestRef.current++;
      navigationRequestRef.current++;
      projectGenerationRef.current++;
      treeRequestRef.current = { ...treeRequestRef.current, loading: new Set() };
      snapshotReadingRef.current = true;
      try {
        await openProject(project);
        await loadWikiSnapshot();
        setPageMode('workspace');
      } finally {
        snapshotReadingRef.current = false;
      }
    }, t('actions.switchedLibrary'));
  }, [loadWikiSnapshot, openProject, run, t]);

  const readProjectFile = useCallback(async (selectedProjectId: string, path: string, open = true) => {
    if (projectIdRef.current !== selectedProjectId || (!open && selectedPathRef.current !== path)) return;
    const request = ++fileRequestRef.current;
    const isCurrent = () => request === fileRequestRef.current && projectIdRef.current === selectedProjectId && selectedPathRef.current === path;
    const meta = classifyWikiPath(path);
    selectedPathRef.current = path;
    setBusy('read');
    if (open) {
      setSelectedPath(path);
      setPreview({ kind: 'empty' });
      setSourceImageIndex(undefined);
      setEditorText('');
      setActiveTab('wiki');
    }
    try {
      if (supportsWikiTextPreview(meta.contentType, meta.ext)) {
        const result = normalizeRead(await hostWikiReadFile({ projectId: selectedProjectId, path }), path);
        if (!isCurrent()) return;
        selectedPathRef.current = result.path;
        setSelectedPath(result.path);
        setEditorText(result.content);
        setPreview({ kind: 'text', path: result.path, content: result.content, ...meta });
        return;
      }
      if (supportsWikiBinaryPreview(meta.contentType)) {
        const result = await hostWikiReadBinaryFile({ projectId: selectedProjectId, path, maxBytes: WIKI_PREVIEW_MAX_BYTES });
        if (!isCurrent()) return;
        setPreview(result.ok && result.data
          ? { kind: 'binary', path, name: result.name ?? path, data: result.data, size: result.size ?? 0, ...meta }
          : { kind: 'error', path, message: t(wikiPreviewErrorKey(result.error)), ...meta });
        return;
      }
      try {
        const result = normalizeRead(await hostWikiReadSourcePreview({ projectId: selectedProjectId, path }), path);
        if (!isCurrent()) return;
        selectedPathRef.current = result.path;
        setSelectedPath(result.path);
        setPreview({ kind: 'source', path: result.path, content: result.content, ...meta });
      } catch (error) {
        if (!isCurrent()) return;
        setPreview(isUnsupportedWikiSourcePreview(error)
          ? { kind: 'unsupported', path, ...meta }
          : { kind: 'error', path, message: t(wikiPreviewErrorKey(undefined)), ...meta });
      }
    } finally {
      if (request === fileRequestRef.current && projectIdRef.current === selectedProjectId) setBusy(null);
    }
  }, [t]);

  const readFile = useCallback(async (path: string) => {
    if (!projectId) return;
    try {
      await readProjectFile(projectId, path);
    } catch (error) {
      if (projectIdRef.current === projectId) toast.error(error instanceof Error ? error.message : t('actions.failed', { label: 'read' }));
    }
  }, [projectId, readProjectFile, t]);

  const onHistoryRestored = useCallback(async (restoredProjectId: string, path: string) => {
    if (projectGeneration !== projectGenerationRef.current || projectIdRef.current !== restoredProjectId) return;
    await loadWikiSnapshot(restoredProjectId);
    if (projectGeneration === projectGenerationRef.current) await readProjectFile(restoredProjectId, path, false);
  }, [loadWikiSnapshot, projectGeneration, readProjectFile]);

  const onFilesChanged = useCallback(async (changedProjectId: string, writtenPages: string[], deletedPages: string[]) => {
    if (projectIdRef.current !== changedProjectId || projectGeneration !== projectGenerationRef.current) return;
    const path = selectedPathRef.current;
    const request = fileRequestRef.current;
    if (deletedPages.includes(path)) {
      fileRequestRef.current++;
      selectedPathRef.current = '';
      setSelectedPath('');
      setPreview({ kind: 'empty' });
      setEditorText('');
      setSourceImageIndex(undefined);
    }
    const tree = treeRequestRef.current;
    const deleted = new Set(deletedPages);
    tree.files = tree.files.filter((item) => !deleted.has(item.path));
    setFiles(tree.files);
    const changedDirectories = new Set([...writtenPages, ...deletedPages].map((page) => page.slice(0, page.lastIndexOf('/') + 1).replace(/\/$/, '')));
    const reload = [...changedDirectories].filter((directory) => tree.loaded.has(directory));
    await loadWikiSnapshot(changedProjectId);
    if (projectIdRef.current !== changedProjectId || projectGeneration !== projectGenerationRef.current) return;
    const refreshedTree = treeRequestRef.current;
    for (const directory of reload) refreshedTree.loaded.delete(directory);
    setLoadedDirectories(new Set(refreshedTree.loaded));
    await Promise.all(reload.map((directory) => loadDirectory(directory, refreshedTree)));
    if (projectIdRef.current !== changedProjectId || projectGeneration !== projectGenerationRef.current || request !== fileRequestRef.current || path !== selectedPathRef.current) return;
    if (writtenPages.includes(path)) await readProjectFile(changedProjectId, path, false);
  }, [loadDirectory, loadWikiSnapshot, projectGeneration, readProjectFile]);

  const onMaintenanceChanged = useCallback(async () => {
    if (!projectId || projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) return;
    const request = fileRequestRef.current;
    const path = selectedPathRef.current;
    const reload = [...treeRequestRef.current.loaded].filter(Boolean);
    await loadWikiSnapshot();
    if (projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) return;
    const tree = treeRequestRef.current;
    for (const directory of reload) tree.loaded.delete(directory);
    await Promise.all(reload.map((directory) => loadDirectory(directory, tree)));
    if (projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) return;
    setGraph(null);
    if (path && path === selectedPathRef.current && request === fileRequestRef.current && (preview.kind !== 'text' || editorText === preview.content)) await readProjectFile(projectId, path, false);
  }, [editorText, loadDirectory, loadWikiSnapshot, preview, projectGeneration, projectId, readProjectFile]);

  const onMissingPageCreated = useCallback(async (createdProjectId: string, path: string) => {
    if (createdProjectId !== projectId || projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) return;
    const request = fileRequestRef.current;
    await loadWikiSnapshot(createdProjectId);
    if (projectIdRef.current !== createdProjectId || projectGeneration !== projectGenerationRef.current) return;
    const directory = path.slice(0, path.lastIndexOf('/') + 1).replace(/\/$/, '');
    const tree = treeRequestRef.current;
    tree.loaded.delete(directory);
    await loadDirectory(directory, tree);
    if (projectIdRef.current === createdProjectId && projectGeneration === projectGenerationRef.current && request === fileRequestRef.current) await readProjectFile(createdProjectId, path);
  }, [loadDirectory, loadWikiSnapshot, projectGeneration, projectId, readProjectFile]);

  const onQuestionSaved = useCallback(async (path: string) => {
    if (!projectId || projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) return;
    const request = fileRequestRef.current;
    await loadWikiSnapshot(projectId);
    if (projectIdRef.current === projectId && projectGeneration === projectGenerationRef.current && request === fileRequestRef.current) await readProjectFile(projectId, path);
  }, [loadWikiSnapshot, projectGeneration, projectId, readProjectFile]);

  const openImageSource = useCallback(async (pagePath: string, imageSrc: string) => {
    if (!projectId) throw new Error(t('search.sourceOpenFailed', { defaultValue: '请先打开知识库，再定位原始来源。' }));
    const request = ++fileRequestRef.current;
    setBusy('read-source');
    try {
      const original = await readOriginalImageSource(projectId, pagePath, imageSrc, t);
      if (projectIdRef.current !== projectId || request !== fileRequestRef.current) throw new Error(t('search.sourceProjectChanged', { defaultValue: '知识库已切换，请在当前知识库重新搜索图片。' }));
      const src = await resolveWikiMarkdownImage(imageSrc, pagePath);
      if (projectIdRef.current !== projectId || request !== fileRequestRef.current) throw new Error(t('search.sourceProjectChanged', { defaultValue: '知识库已切换，请在当前知识库重新搜索图片。' }));
      if (!src) throw new Error(t('search.imageUnavailable', { defaultValue: '图片无法加载，请重新导入来源后重试。' }));
      selectedPathRef.current = original.path;
      setSelectedPath(original.path);
      setEditorText('');
      setSourceImageIndex(original.imageIndex);
      setPreview({ kind: 'source', path: original.path, content: original.content, ...classifyWikiPath(original.path) });
      setActiveTab('wiki');
    } finally {
      if (projectIdRef.current === projectId && request === fileRequestRef.current) setBusy(null);
    }
  }, [projectId, t]);

  const toggleDirectory = useCallback(async (directory: string) => {
    if (expandedDirectories.has(directory)) {
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.delete(directory);
        return next;
      });
      return;
    }

    setExpandedDirectories((current) => new Set(current).add(directory));
    if (loadedDirectories.has(directory)) return;

    await loadDirectory(directory);
  }, [expandedDirectories, loadDirectory, loadedDirectories]);

  const retryDirectory = useCallback((directory: string) => {
    void loadDirectory(directory);
  }, [loadDirectory]);

  const retryNavigation = useCallback(() => {
    if (projectId) void loadNavigation(projectId);
  }, [loadNavigation, projectId]);

  const openProjectFolder = useCallback(async () => {
    if (!currentProject) return;
    try {
      const error = await openArtifactPathExternally(currentProject.rootPath);
      if (error) throw new Error(error);
    } catch {
      toast.error(t('sidebar.openFolderFailed'));
    }
  }, [currentProject, t]);

  const deletePage = useCallback(async (path: string): Promise<void> => {
    if (!projectId || projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) throw new Error(t('actions.projectChanged'));
    setBusy('delete-page');
    try {
      const receipt = await hostWikiDeletePage({ projectId, path });
      const call = await waitForCall(receipt, 'wiki');
      if (projectGeneration !== projectGenerationRef.current || projectIdRef.current !== projectId) throw new Error(t('actions.projectChanged'));
      if (call.command !== 'delete-page' || call.detail.operation !== 'delete-page') throw new Error(t('actions.resultUnconfirmed'));
      const result = await hostWikiCallResult({ callId: receipt.callId });
      if (projectGeneration !== projectGenerationRef.current || projectIdRef.current !== projectId) throw new Error(t('actions.projectChanged'));
      if (result.callId !== receipt.callId || result.operation !== 'delete-page' || result.result.projectId !== projectId || result.result.path !== path) throw new Error(t('actions.resultUnconfirmed'));
      await onFilesChanged(projectId, result.result.updatedPages, result.result.deletedPages);
      if (projectGeneration !== projectGenerationRef.current || projectIdRef.current !== projectId) throw new Error(t('actions.projectChanged'));
      if (!result.result.deletedPages.includes(path) || result.result.failures.length > 0 || call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        const details = result.result.failures.map((failure) => `${failure.stage}: ${failure.message}`).join('\n');
        throw new Error([t('sidebar.deleteFailed'), details].filter(Boolean).join('\n'));
      }
      const counts = call.detail.counts;
      if (!counts || result.result.deletedPages.length !== counts.deletedPages || result.result.updatedPages.length !== counts.updatedPages || result.result.deletedMedia.length !== counts.deletedMedia) throw new Error(t('actions.resultUnconfirmed'));
    } finally {
      if (projectGeneration === projectGenerationRef.current && projectIdRef.current === projectId) setBusy(null);
    }
  }, [onFilesChanged, projectGeneration, projectId, t]);

  const saveFile = useCallback(async () => {
    if (!selectedPath || preview.kind !== 'text') return;
    const currentPreview = preview;
    if (!projectId) return;
    await run('write', async () => {
      await hostWikiWriteFile({ projectId, path: selectedPath, content: editorText });
      if (projectGeneration !== projectGenerationRef.current || projectIdRef.current !== projectId) return;
      setPreview({ ...currentPreview, content: editorText });
      await loadWikiSnapshot(projectId);
    }, t('actions.savedPage'));
  }, [editorText, loadWikiSnapshot, preview, projectGeneration, projectId, run, selectedPath, t]);

  const onSelectionPrepare = useCallback(async (selection: WikiSelectionSnapshot) => {
    if (!projectId || preview.kind !== 'text' || selectedPathRef.current !== selectedPath
      || projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) throw new Error(t('actions.projectChanged'));
    const content = selection.prefix + selection.selectedText + selection.suffix;
    const draft = editorTextRef.current;
    if (draft !== content && normalizeEditableMarkdown(draft) !== content) throw new Error(t('selection.sourceChanged'));
    if (content === preview.content) return;
    setBusy('write');
    try {
      await hostWikiWriteFile({ projectId, path: selectedPath, content });
      if (projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current || selectedPathRef.current !== selectedPath) throw new Error(t('actions.projectChanged'));
      if (editorTextRef.current !== draft) throw new Error(t('selection.sourceChanged'));
      setEditorText(content);
      setPreview({ ...preview, content });
    } finally {
      if (projectIdRef.current === projectId && projectGeneration === projectGenerationRef.current) setBusy(null);
    }
  }, [preview, projectGeneration, projectId, selectedPath, t]);

  const onSelectionApplied = useCallback(async (receipt: WikiSelectionApplyReceipt) => {
    if (receipt.projectId !== projectId || projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) return;
    if (selectedPathRef.current === receipt.relativePath && preview.kind === 'text' && editorTextRef.current === preview.content) {
      setEditorText(receipt.content);
      setPreview((current) => current.kind === 'text' && current.path === receipt.relativePath ? { ...current, content: receipt.content } : current);
    }
    setGraph(null);
    await loadWikiSnapshot(receipt.projectId);
    if (projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) return;
    const directory = receipt.relativePath.slice(0, receipt.relativePath.lastIndexOf('/') + 1).replace(/\/$/, '');
    const tree = treeRequestRef.current;
    tree.loaded.delete(directory);
    await loadDirectory(directory, tree);
  }, [loadDirectory, loadWikiSnapshot, preview, projectGeneration, projectId]);

  const rescan = useCallback(async () => {
    await run('rescan', async () => {
      const call = await hostWikiRescanSources()
        .then((receipt) => waitForCall(receipt, 'wiki'))
        .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
      if (call.command !== 'rescan-sources' || call.detail.operation !== 'rescan-sources' || call.status === 'unknown') {
        throw new Error(t('actions.resultUnconfirmed'));
      }
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('actions.failed', { label: 'rescan-sources' }));
      }
      await loadWikiSnapshot();
    }, t('actions.rescanned'));
  }, [loadWikiSnapshot, run, t]);

  const importSourcePath = useCallback(async (path: string) => {
    if (!projectId || projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) return;
    await run('import-source', async () => {
      const call = await hostWikiImportSource({ projectId, sourcePath: path })
        .then((receipt) => waitForCall(receipt, 'wiki'))
        .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
      if (call.command !== 'import-source' || call.detail.operation !== 'import-source' || call.status === 'unknown') {
        throw new Error(t('actions.resultUnconfirmed'));
      }
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('actions.failed', { label: 'import-source' }));
      }
      if (call.detail.counts === null) throw new Error(t('actions.resultUnconfirmed'));
      if (projectGeneration !== projectGenerationRef.current || projectIdRef.current !== projectId) return;
      setLastReceipt(summarizeSourceCallCounts(call.detail.counts, t('actions.importFileReceipt')));
      await loadWikiSnapshot(projectId);
    }, t('actions.importedSource'));
  }, [loadWikiSnapshot, projectGeneration, projectId, run, t]);

  const pickAndImportSource = useCallback(async () => {
    const path = await pickLocalFile({
      title: t('actions.pickSourceFileTitle'),
      buttonLabel: t('actions.importFileButton'),
    });
    if (!path) return;
    await importSourcePath(path);
  }, [importSourcePath, t]);

  const importFolderPath = useCallback(async (path: string) => {
    if (!projectId || projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) return;
    await run('import-folder', async () => {
      const call = await hostWikiImportFolder({ projectId, folderPath: path })
        .then((receipt) => waitForCall(receipt, 'wiki'))
        .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
      if (call.command !== 'import-folder' || call.detail.operation !== 'import-folder' || call.status === 'unknown') {
        throw new Error(t('actions.resultUnconfirmed'));
      }
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('actions.failed', { label: 'import-folder' }));
      }
      if (call.detail.counts === null) throw new Error(t('actions.resultUnconfirmed'));
      if (projectGeneration !== projectGenerationRef.current || projectIdRef.current !== projectId) return;
      setLastReceipt(summarizeSourceCallCounts(call.detail.counts, t('actions.importFolderReceipt')));
      await loadWikiSnapshot(projectId);
    }, t('actions.importedFolder'));
  }, [loadWikiSnapshot, projectGeneration, projectId, run, t]);

  const pickAndImportFolder = useCallback(async () => {
    const path = await pickLocalDirectory({
      title: t('actions.pickSourceFolderTitle'),
      buttonLabel: t('actions.importFolderButton'),
    });
    if (!path) return;
    await importFolderPath(path);
  }, [importFolderPath, t]);

  const deleteSourceAtPath = useCallback(async (path: string) => {
    if (!path.trim()) return;
    await run('delete-source', async () => {
      const call = await hostWikiDeleteSource({ sourcePath: path })
        .then((receipt) => waitForCall(receipt, 'wiki'))
        .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
      if (call.command !== 'delete-source' || call.detail.operation !== 'delete-source' || call.status === 'unknown') {
        throw new Error(t('actions.resultUnconfirmed'));
      }
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('actions.failed', { label: 'delete-source' }));
      }
      const result = await hostWikiCallResult({ callId: call.callId })
        .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
      if (result.callId !== call.callId || result.operation !== 'delete-source' || call.detail.counts === null
        || result.result.deletedPages.length !== call.detail.counts.deletedPages
        || result.result.updatedPages.length !== call.detail.counts.updatedPages
        || result.result.deletedMedia.length !== call.detail.counts.deletedMedia) {
        throw new Error(t('actions.resultUnconfirmed'));
      }
      setLastReceipt(summarizeDeleteSourceResult(result.result, t('actions.deleteSourceReceipt')));
      await loadWikiSnapshot();
    }, t('actions.deletedSource'));
  }, [loadWikiSnapshot, run, t]);

  const refreshSources = useCallback(async () => {
    if (!projectId || projectIdRef.current !== projectId || projectGeneration !== projectGenerationRef.current) return;
    await run('refresh-sources', async () => {
      const call = await hostWikiRefreshSources({ projectId })
        .then((receipt) => waitForCall(receipt, 'wiki'))
        .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
      if (call.command !== 'refresh-sources' || call.detail.operation !== 'refresh-sources' || call.status === 'unknown') {
        throw new Error(t('actions.resultUnconfirmed'));
      }
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('actions.failed', { label: 'refresh-sources' }));
      }
      if (call.detail.counts === null) throw new Error(t('actions.resultUnconfirmed'));
      if (projectGeneration !== projectGenerationRef.current || projectIdRef.current !== projectId) return;
      setLastReceipt(summarizeSourceCallCounts(call.detail.counts, t('actions.refreshSourcesReceipt')));
      await loadWikiSnapshot(projectId);
    }, t('actions.refreshedSources'));
  }, [loadWikiSnapshot, projectGeneration, projectId, run, t]);

  const loadSourceTasks = useCallback(async () => {
    if (projectId) await readSourceTasks(projectId);
  }, [projectId, readSourceTasks]);

  const cancelSourceTask = useCallback(async (sourcePath: string) => {
    if (!projectId || useWikiProjectsStore.getState().switching) return;
    const key = JSON.stringify([projectId, sourcePath]);
    if (cancellingSourceTasksRef.current.has(key)) return;
    const generation = projectGenerationRef.current;
    const isCurrent = () => generation === projectGenerationRef.current && projectIdRef.current === projectId
      && useWikiProjectsStore.getState().currentProject?.projectId === projectId && !useWikiProjectsStore.getState().switching;
    cancellingSourceTasksRef.current.add(key);
    setCancellingSourceTasks(new Set(cancellingSourceTasksRef.current));
    try {
      const tasks = normalizeSourceTasks(await hostWikiCancelSourceTask({ projectId, sourcePath }));
      if (!isCurrent()) return;
      sourceTaskRevisionRef.current++;
      setSourceTaskProjection({ projectId, tasks });
    } catch {
      if (isCurrent()) toast.error(t('sourceProgress.cancelFailed'));
    } finally {
      cancellingSourceTasksRef.current.delete(key);
      if (mountedRef.current) setCancellingSourceTasks(new Set(cancellingSourceTasksRef.current));
    }
  }, [projectId, t]);

  const updateSourceWatchConfig = useCallback(async (payload: WikiSourceWatchConfigUpdate) => {
    await run('source-watch-config', async () => {
      const receipt = await hostWikiUpdateSourceWatchConfig(payload);
      setSourceWatchConfig(normalizeSourceWatchConfig(receipt.config));
    }, t('actions.updatedSourceWatch'));
  }, [run, t]);

  const loadReviews = useCallback(async () => {
    await run('reviews', async () => {
      setReviewItems(normalizeReviews(await hostWikiReviews()));
    });
  }, [run]);

  const resolveReview = useCallback(async (id: string, action: string) => {
    await run('review-resolve', async () => {
      setReviewItems(normalizeReviews(await hostWikiResolveReview({ id, action })));
    }, t('actions.resolvedReview'));
  }, [run, t]);

  const dismissReview = useCallback(async (id: string) => {
    await run('review-dismiss', async () => {
      setReviewItems(normalizeReviews(await hostWikiDismissReview({ id })));
    }, t('actions.dismissedReview'));
  }, [run, t]);

  const clearResolvedReviews = useCallback(async () => {
    await run('review-clear', async () => {
      setReviewItems(normalizeReviews(await hostWikiClearResolvedReviews()));
    }, t('actions.clearedReviews'));
  }, [run, t]);

  const createReviewPage = useCallback(async (item: WikiReviewItem) => {
    await run('review-create-page', async () => {
      const drafts = createReviewPageDrafts(item, 'Create Page');
      const created = drafts.map((draft) => {
        const { fileName, date } = makeQueryFileName(draft.title);
        const path = `wiki/${draft.dir}/${fileName}`;
        const content = `---\ntype: ${draft.pageType}\ntitle: "${draft.title.replace(/"/g, '\\"')}"\ncreated: ${date}\ntags: []\nrelated: []\n---\n\n# ${draft.title}\n\n${item.description}\n`;
        return { path, content, title: draft.title, dir: draft.dir, fileName };
      });
      for (const page of created) {
        await hostWikiWriteFile({ path: page.path, content: page.content });
      }
      if (created.length > 0) {
        let indexContent = '# Wiki Index\n';
        try {
          indexContent = normalizeRead(await hostWikiReadFile({ path: 'wiki/index.md' }), 'wiki/index.md').content;
        } catch {
          // keep default
        }
        for (const page of created) {
          const sectionHeader = `## ${page.dir.charAt(0).toUpperCase()}${page.dir.slice(1)}`;
          const linkTarget = page.fileName.replace(/\.md$/, '');
          const entry = `- [[${page.dir}/${linkTarget}|${page.title}]]`;
          indexContent = indexContent.includes(sectionHeader)
            ? indexContent.replace(new RegExp(`(${sectionHeader}\\n)`), (match) => `${match}${entry}\n`)
            : `${indexContent.trimEnd()}\n\n${sectionHeader}\n${entry}\n`;
        }
        await hostWikiWriteFile({ path: 'wiki/index.md', content: indexContent });

        let logContent = '# Wiki Log\n';
        try {
          logContent = normalizeRead(await hostWikiReadFile({ path: 'wiki/log.md' }), 'wiki/log.md').content;
        } catch {
          // keep default
        }
        const createdNames = created.map((page) => `\`${page.fileName}\``).join(', ');
        await hostWikiWriteFile({ path: 'wiki/log.md', content: `${logContent.trimEnd()}\n- ${makeQueryFileName('review').date}: Created ${created.length} page${created.length === 1 ? '' : 's'} from review: ${createdNames}\n` });
      }
      const first = created[0];
      if (first) {
        setSelectedPath(first.path);
        setEditorText(first.content);
        setPreview({ kind: 'text', path: first.path, content: first.content, ...classifyWikiPath(first.path) });
        setActiveTab('wiki');
      }
      setReviewItems(normalizeReviews(await hostWikiResolveReview({ id: item.id, action: first ? `Created: ${first.path}` : 'Created page' })));
      await loadWikiSnapshot();
    }, t('actions.createdReviewPage'));
  }, [loadWikiSnapshot, run, t]);

  const searchPages = useCallback(async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;
    await run('search', async () => {
      setSearchResult(normalizeSearch(await hostWikiSearch({ query: trimmedQuery })));
    });
  }, [query, run]);

  const retrieveContext = useCallback(async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;
    await run('context', async () => {
      setContextResult(normalizeSearch(await hostWikiRetrieveContext({ query: trimmedQuery })));
    });
  }, [query, run]);

  const loadGraph = useCallback(async () => {
    if (!projectId) return;
    await run('graph', async () => {
      const next = normalizeGraph(await hostWikiGraph({ projectId }));
      if (projectIdRef.current === projectId) setGraph(next);
    });
  }, [projectId, run]);

  const locateGraphNodes = useCallback((nodeIds: readonly string[]) => {
    if (projectIdRef.current !== projectId) return;
    setHighlightedNodeIds(nodeIds);
    if (nodeIds.length > 0 && !graph) void loadGraph();
  }, [graph, loadGraph, projectId]);

  const embedPage = useCallback(async () => {
    if (!projectId || !selectedPath || preview.kind !== 'text' || preview.contentType !== 'markdown') return;
    if (editorText !== preview.content) {
      toast.error(t('content.saveBeforeEmbed'));
      return;
    }
    await run('embed', async () => {
      const receipt = await hostWikiEmbedPage({ projectId, path: selectedPath });
      const call = await waitForCall(receipt, 'wiki')
        .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
      if (call.command !== 'embed-page' || call.detail.operation !== 'embed-page' || call.status === 'unknown') {
        throw new Error(t('actions.resultUnconfirmed'));
      }
      const result = await hostWikiCallResult({ callId: receipt.callId })
        .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
      if (result.callId !== receipt.callId || result.operation !== 'embed-page' || result.result.projectId !== projectId) {
        throw new Error(t('actions.resultUnconfirmed'));
      }
      if (result.result.status === 'failed') throw new Error(t(`embeddingErrors.${result.result.code}`));
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('actions.resultUnconfirmed'));
      }
    }, t('actions.embeddedPage'));
  }, [editorText, preview, projectId, run, selectedPath, t]);

  const changeWorkspaceTab = useCallback((tab: WikiWorkspaceTab) => {
    setActiveTab(tab);
    if (tab === 'sources') setSourceView('sources');
    if (tab === 'qa' && projectId) setQuestionProjectId(projectId);
  }, [projectId]);

  const activePanel = useMemo(() => {
    switch (activeTab) {
      case 'sources':
        return projectId ? (
          <SourcesPanel
            projectId={projectId}
            files={sourceFiles}
            sourceTasks={sourceTasks}
            sourceTasksError={sourceTasksError}
            cancellingSourcePaths={cancellingSourcePaths}
            sourceWatchConfig={sourceWatchConfig}
            lastReceipt={lastReceipt}
            busy={busy}
            view={sourceView}
            onPickSourceFile={pickAndImportSource}
            onPickSourceFolder={pickAndImportFolder}
            onOpenSource={readFile}
            onDeleteSourcePath={deleteSourceAtPath}
            onRescanSources={rescan}
            onLoadSourceTasks={loadSourceTasks}
            onSourceWatchEnabledChange={(enabled) => { void updateSourceWatchConfig({ enabled }); }}
            onAutoIngestChange={(autoIngest) => { void updateSourceWatchConfig({ autoIngest }); }}
            onOutputLanguageChange={(outputLanguage) => { void updateSourceWatchConfig({ outputLanguage }); }}
            onCaptionEnabledChange={(captionEnabled) => { void updateSourceWatchConfig({ captionEnabled }); }}
            onMineruEnabledChange={(mineruEnabled) => { void updateSourceWatchConfig({ mineruEnabled }); }}
            onSourceWatchConfigChange={updateSourceWatchConfig}
            onCancelSourceTask={(sourcePath) => { void cancelSourceTask(sourcePath); }}
          />
        ) : null;
      case 'review':
        return (
          <ReviewPanel
            items={reviewItems}
            busy={busy}
            onRefresh={loadReviews}
            onResolve={resolveReview}
            onDismiss={dismissReview}
            onClearResolved={clearResolvedReviews}
            onCreatePage={createReviewPage}
          />
        );
      case 'qa':
        return null;
      case 'lint':
        return projectId ? <LintPanel key={projectId} projectId={projectId} busy={busy} initialModelRef={sourceWatchConfig.generationModelRef} onOpenFile={readFile} onFilesChanged={onFilesChanged} /> : null;
      case 'maintenance':
        return projectId ? <MaintenancePanel key={projectId} projectId={projectId} projectName={currentProject?.title} modelRef={sourceWatchConfig.generationModelRef} busy={busy} onChanged={onMaintenanceChanged} /> : null;
      case 'search':
        return (
          <SearchPanel
            query={query}
            searchResult={searchResult}
            contextResult={contextResult}
            busy={busy}
            onQueryChange={setQuery}
            onSearch={searchPages}
            onRetrieveContext={retrieveContext}
            onOpenResult={readFile}
            onOpenSource={openImageSource}
          />
        );
      case 'graph':
        return (
          <div className="grid h-full min-h-0 grid-rows-[minmax(320px,1fr)_minmax(240px,1fr)] xl:grid-cols-[minmax(0,1fr)_360px] xl:grid-rows-1">
            <GraphPanel
              key={projectId}
              graph={graph}
              selectedPath={selectedPath}
              highlightedNodeIds={highlightedNodeIds}
              busy={busy}
              onLoadGraph={loadGraph}
              onEmbedPage={embedPage}
              onOpenNode={readFile}
            />
            {projectId ? <div className="min-h-0 overflow-auto border-t xl:border-l xl:border-t-0"><GraphInsightsPanel key={projectId} projectId={projectId} busy={busy} onLocateNodes={locateGraphNodes} /></div> : null}
          </div>
        );
      case 'wiki':
        return projectId ? (
          <WikiContentPanel
            key={JSON.stringify([projectId, selectedPath])}
            projectId={projectId}
            selectedPath={selectedPath}
            preview={preview}
            sourceImageIndex={sourceImageIndex}
            editorText={editorText}
            busy={busy}
            resolveImageSrc={resolveWikiMarkdownImage}
            onEditorTextChange={setEditorText}
            onSave={saveFile}
            onEmbedPage={embedPage}
            onRestored={onHistoryRestored}
            onOpenFile={readFile}
            onCreated={onMissingPageCreated}
            modelRef={sourceWatchConfig.generationModelRef || undefined}
            onSelectionPrepare={onSelectionPrepare}
            onSelectionApplied={onSelectionApplied}
          />
        ) : null;
    }
  }, [
    activeTab,
    busy,
    contextResult,
    currentProject?.title,
    deleteSourceAtPath,
    editorText,
    embedPage,
    graph,
    highlightedNodeIds,
    lastReceipt,
    loadGraph,
    locateGraphNodes,
    loadReviews,
    loadSourceTasks,
    onFilesChanged,
    onHistoryRestored,
    onMaintenanceChanged,
    onMissingPageCreated,
    onSelectionPrepare,
    onSelectionApplied,
    pickAndImportFolder,
    pickAndImportSource,
    preview,
    query,
    readFile,
    rescan,
    refreshSources,
    resolveReview,
    retrieveContext,
    reviewItems,
    saveFile,
    searchPages,
    searchResult,
    selectedPath,
    sourceFiles,
    sourceTasks,
    sourceTasksError,
    cancellingSourcePaths,
    sourceView,
    sourceWatchConfig,
    updateSourceWatchConfig,
    dismissReview,
    clearResolvedReviews,
    createReviewPage,
    cancelSourceTask,
    openImageSource,
    projectId,
    sourceImageIndex,
  ]);

  if (pageMode === 'home' || !currentProject) {
    return (
      <LibraryHome
        status={{ ...status, currentProject }}
        projects={projects}
        templates={projectTemplates}
        selectedTemplateId={selectedTemplateId}
        openPath={openPath}
        projectName={projectName}
        busy={busy}
        onOpenPathChange={setOpenPath}
        onProjectNameChange={setProjectName}
        onTemplateChange={setSelectedTemplateId}
        onPickDirectory={chooseLibraryDirectory}
        onCreateProject={createLibrary}
        onSelectProject={selectProject}
        onRefresh={refresh}
      />
    );
  }

  return (
    <LibraryWorkspace
      key={currentProject.projectId}
      currentProject={currentProject}
      files={files}
      expandedDirectories={expandedDirectories}
      loadedDirectories={loadedDirectories}
      loadingDirectories={loadingDirectories}
      directoryErrors={directoryErrors}
      pages={navigationPages}
      sourceFiles={sourceFiles}
      navigationLoading={navigationLoading}
      navigationError={navigationError}
      selectedPath={selectedPath}
      activeTab={activeTab}
      sourceView={sourceView}
      busy={busy}
      questionPanel={questionProjectId === projectId ? <QuestionPanel key={projectId} projectId={currentProject.projectId} initialModelRef={sourceWatchConfig.generationModelRef} busy={busy} onOpenFile={(path) => readProjectFile(currentProject.projectId, path)} onSaved={onQuestionSaved} /> : undefined}
      activity={<ActivityBar status={status} sourceTasks={sourceTasks} busy={busy} sourceTasksError={sourceTasksError} cancellingSourcePaths={cancellingSourcePaths} onLoadSourceTasks={loadSourceTasks} onCancelSourceTask={cancelSourceTask} />}
      onTabChange={changeWorkspaceTab}
      onSourceViewChange={setSourceView}
      onBackHome={() => setPageMode('home')}
      onRefresh={refresh}
      onSelectFile={readFile}
      onToggleDirectory={toggleDirectory}
      onRetryDirectory={retryDirectory}
      onRetryNavigation={retryNavigation}
      onDeletePage={deletePage}
      onOpenFolder={openProjectFolder}
    >
      {activePanel}
    </LibraryWorkspace>
  );
}
