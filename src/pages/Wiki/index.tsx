import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { pickLocalDirectory, pickLocalFile } from '@/services/local-path-picker';
import { waitForCall } from '@/lib/call-log-await';
import { LibraryHome } from './components/LibraryHome';
import { LibraryWorkspace } from './components/LibraryWorkspace';
import { ActivityBar } from './components/ActivityBar';
import { GraphPanel } from './components/GraphPanel';
import { GraphInsightsPanel } from './components/GraphInsightsPanel';
import { LintPanel } from './components/LintPanel';
import { MaintenancePanel } from './components/MaintenancePanel';
import { QuestionPanel } from './components/QuestionPanel';
import { SearchPanel } from './components/SearchPanel';
import { SourcesPanel } from './components/SourcesPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { ResearchPanel } from './components/ResearchPanel';
import { SearchSettingsPanel } from './components/SearchSettingsPanel';
import { isTerminalResearchTask, reviewResearchTopic } from './research-model';
import { WikiContentPanel, type WikiContentPreview } from './components/WikiContentPanel';
import { classifyWikiPath, isUnsupportedWikiSourcePreview, supportsWikiBinaryPreview, supportsWikiTextPreview, wikiPreviewErrorKey } from './preview';
import { resolveWikiMarkdownImage } from './wiki-media';
import { readOriginalImageSource } from './wiki-source-navigation';
import {
  hostWikiCancelSourceTask,
  hostWikiCallResult,
  hostWikiCreateProject,
  hostWikiCurrentProject,
  hostWikiDeleteSource,
  hostWikiEmbedPage,
  hostWikiFiles,
  hostWikiGraph,
  hostWikiImportFolder,
  hostWikiImportSource,
  hostWikiOpenProject,
  hostWikiProjectTemplates,
  hostWikiProjects,
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
  hostWikiResearchTasks,
  hostWikiStartResearch,
  hostWikiRerunResearchTask,
  hostWikiRemoveResearchTask,
  hostWikiSearchConfig,
  hostWikiUpdateSearchConfig,
  hostWikiTestSearchProvider,
  type HostWikiResearchInput,
  type HostWikiResearchTask,
  type HostWikiSearchConfig,
  type HostWikiSearchConfigUpdate,
  hostWikiSourceFiles,
  hostWikiSourceTasks,
  hostWikiSourceWatchConfig,
  hostWikiStatus,
  hostWikiUpdateSourceWatchConfig,
  hostWikiWriteFile,
} from '@/lib/host-api';
import {
  currentProjectFromPayload,
  normalizeFiles,
  normalizeGraph,
  normalizeProjectTemplates,
  normalizeProjects,
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

const WIKI_TREE_ROOT_DIRECTORIES = ['wiki', 'raw'] as const;
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

function defaultExpandedDirectories(): ReadonlySet<string> {
  return new Set(WIKI_TREE_ROOT_DIRECTORIES);
}

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

type LoadedWikiFiles = Readonly<{
  files: readonly WikiFileItem[];
  directories: readonly string[];
}>;

async function loadDirectories(directories: readonly string[], projectId?: string): Promise<LoadedWikiFiles> {
  const results = await Promise.allSettled(directories.map(async (directory) => {
    const files = normalizeFiles(await hostWikiFiles({ directory, projectId }));
    return { directory, files };
  }));

  return results.reduce<LoadedWikiFiles>((loaded, result) => {
    if (result.status !== 'fulfilled') {
      return loaded;
    }
    return {
      files: [...loaded.files, ...result.value.files],
      directories: [...loaded.directories, result.value.directory],
    };
  }, { files: [], directories: [] });
}

export default function WikiPage() {
  const { t } = useTranslation('wiki');
  const [pageMode, setPageMode] = useState<WikiPageMode>('home');
  const [status, setStatus] = useState<WikiStatus>(EMPTY_STATUS);
  const [projects, setProjects] = useState<readonly WikiProject[]>([]);
  const [projectTemplates, setProjectTemplates] = useState<readonly WikiProjectTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('general');
  const [currentProject, setCurrentProject] = useState<WikiProject | null>(null);
  const [files, setFiles] = useState<readonly WikiFileItem[]>([]);
  const [sourceFiles, setSourceFiles] = useState<readonly WikiFileItem[]>([]);
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(defaultExpandedDirectories);
  const [loadedDirectories, setLoadedDirectories] = useState<ReadonlySet<string>>(() => new Set());
  const [sourceTasks, setSourceTasks] = useState<readonly WikiSourceTask[]>([]);
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
  const [busy, setBusy] = useState<string | null>('load');
  const [researchTasks, setResearchTasks] = useState<readonly HostWikiResearchTask[]>([]);
  const [searchConfig, setSearchConfig] = useState<Readonly<{ projectId: string; config: HostWikiSearchConfig }> | null>(null);
  const [researchPollVersion, setResearchPollVersion] = useState(0);
  const projectId = currentProject?.projectId;
  const projectIdRef = useRef(projectId);
  const selectedPathRef = useRef(selectedPath);
  const fileRequestRef = useRef(0);
  const snapshotRequestRef = useRef(0);
  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);
  useEffect(() => { selectedPathRef.current = selectedPath; }, [selectedPath]);
  useEffect(() => () => { fileRequestRef.current++; snapshotRequestRef.current++; }, []);

  const run = useCallback(async (label: string, task: () => Promise<void>, success?: string) => {
    setBusy(label);
    try {
      await task();
      if (success) toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('actions.failed', { label }));
    } finally {
      setBusy(null);
    }
  }, [t]);

  const loadWikiSnapshot = useCallback(async (expectedProjectId?: string) => {
    if (expectedProjectId && projectIdRef.current !== expectedProjectId) return;
    const request = ++snapshotRequestRef.current;
    const [statusResult, projectsResult, templatesResult, currentProjectResult] = await Promise.allSettled([
      hostWikiStatus(),
      hostWikiProjects(),
      hostWikiProjectTemplates(),
      hostWikiCurrentProject(),
    ]);

    const nextStatus = statusResult.status === 'fulfilled' ? normalizeStatus(statusResult.value) : EMPTY_STATUS;
    const nextProjects = projectsResult.status === 'fulfilled' ? normalizeProjects(projectsResult.value) : [];
    const nextTemplates = templatesResult.status === 'fulfilled' ? normalizeProjectTemplates(templatesResult.value) : [];
    const nextCurrentProject = currentProjectResult.status === 'fulfilled'
      ? currentProjectFromPayload(currentProjectResult.value, nextStatus, nextProjects)
      : currentProjectFromPayload(null, nextStatus, nextProjects);

    const nextProjectId = nextCurrentProject?.projectId;
    if (request !== snapshotRequestRef.current || (expectedProjectId && (projectIdRef.current !== expectedProjectId || nextProjectId !== expectedProjectId))) return;
    const [fileTreeResult, sourceFilesResult, sourceWatchResult, sourceTasksResult, reviewsResult] = await Promise.allSettled([
      nextProjectId ? loadDirectories(WIKI_TREE_ROOT_DIRECTORIES, nextProjectId) : Promise.resolve({ files: [], directories: [] }),
      nextProjectId ? hostWikiSourceFiles({ projectId: nextProjectId }) : Promise.resolve([]),
      nextProjectId ? hostWikiSourceWatchConfig({ projectId: nextProjectId }) : Promise.resolve({ config: DEFAULT_SOURCE_WATCH_CONFIG }),
      nextProjectId ? hostWikiSourceTasks({ projectId: nextProjectId }) : Promise.resolve([]),
      nextProjectId ? hostWikiReviews({ projectId: nextProjectId }) : Promise.resolve([]),
    ]);
    if (request !== snapshotRequestRef.current || (expectedProjectId && projectIdRef.current !== expectedProjectId)) return;
    const nextFileTree = fileTreeResult.status === 'fulfilled' ? fileTreeResult.value : { files: [], directories: [] };
    const nextSourceFiles = sourceFilesResult.status === 'fulfilled' ? normalizeFiles(sourceFilesResult.value) : [];

    if (projectIdRef.current !== nextCurrentProject?.projectId) {
      projectIdRef.current = nextCurrentProject?.projectId;
      fileRequestRef.current++;
      selectedPathRef.current = '';
      setQuestionProjectId(null);
      setGraph(null);
      setHighlightedNodeIds([]);
      setResearchTasks([]);
      setSearchConfig(null);
      setSearchResult(null);
      setContextResult(null);
      setSelectedPath('');
      setSourceImageIndex(undefined);
      setPreview({ kind: 'empty' });
      setEditorText('');
    }
    setStatus(nextStatus);
    setProjects(nextProjects);
    setProjectTemplates(nextTemplates);
    setCurrentProject(nextCurrentProject);
    setFiles(mergeFileItems([], nextFileTree.files));
    setSourceFiles(mergeFileItems([], nextSourceFiles));
    setLoadedDirectories(new Set(nextFileTree.directories));
    setExpandedDirectories(defaultExpandedDirectories());
    setSourceWatchConfig(sourceWatchResult.status === 'fulfilled' ? normalizeSourceWatchConfig(sourceWatchResult.value.config) : DEFAULT_SOURCE_WATCH_CONFIG);
    setSourceTasks(sourceTasksResult.status === 'fulfilled' ? normalizeSourceTasks(sourceTasksResult.value) : []);
    setReviewItems(reviewsResult.status === 'fulfilled' ? normalizeReviews(reviewsResult.value) : []);

    if (!nextCurrentProject) {
      setPageMode('home');
      setSelectedPath('');
      setSourceFiles([]);
      setReviewItems([]);
      setPreview({ kind: 'empty' });
      setEditorText('');
    }
  }, []);

  const refresh = useCallback(async () => {
    await run('load', () => loadWikiSnapshot());
  }, [loadWikiSnapshot, run]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      await hostWikiCreateProject({ path, name: projectName.trim() || undefined, templateId: selectedTemplateId });
      await loadWikiSnapshot();
      setPageMode('workspace');
    }, t('actions.createdLibrary'));
  }, [loadWikiSnapshot, openPath, projectName, run, selectedTemplateId, t]);

  const selectProject = useCallback(async (project: WikiProject) => {
    await run('open', async () => {
      fileRequestRef.current++;
      snapshotRequestRef.current++;
      await hostWikiOpenProject({ path: project.rootPath, name: project.title });
      await loadWikiSnapshot();
      setPageMode('workspace');
    }, t('actions.switchedLibrary'));
  }, [loadWikiSnapshot, run, t]);

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
    await readProjectFile(restoredProjectId, path, false);
  }, [readProjectFile]);

  const onFilesChanged = useCallback(async (changedProjectId: string, writtenPages: string[], deletedPages: string[]) => {
    if (projectIdRef.current !== changedProjectId) return;
    const path = selectedPathRef.current;
    const request = fileRequestRef.current;
    await loadWikiSnapshot(changedProjectId);
    if (projectIdRef.current !== changedProjectId || request !== fileRequestRef.current || path !== selectedPathRef.current) return;
    if (deletedPages.includes(path)) {
      fileRequestRef.current++;
      selectedPathRef.current = '';
      setSelectedPath('');
      setPreview({ kind: 'empty' });
      setEditorText('');
      setSourceImageIndex(undefined);
    } else if (writtenPages.includes(path)) await readProjectFile(changedProjectId, path, false);
  }, [loadWikiSnapshot, readProjectFile]);

  const onQuestionSaved = useCallback(async (path: string) => {
    if (!projectId || projectIdRef.current !== projectId) return;
    const request = fileRequestRef.current;
    await loadWikiSnapshot(projectId);
    if (projectIdRef.current === projectId && request === fileRequestRef.current) await readProjectFile(projectId, path);
  }, [loadWikiSnapshot, projectId, readProjectFile]);

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

    await run('files', async () => {
      const children = normalizeFiles(await hostWikiFiles({ directory }));
      setFiles((current) => mergeFileItems(current, children));
      setLoadedDirectories((current) => new Set(current).add(directory));
    });
  }, [expandedDirectories, loadedDirectories, run]);

  const saveFile = useCallback(async () => {
    if (!selectedPath || preview.kind !== 'text') return;
    const currentPreview = preview;
    await run('write', async () => {
      await hostWikiWriteFile({ path: selectedPath, content: editorText });
      setPreview({ ...currentPreview, content: editorText });
      await loadWikiSnapshot();
    }, t('actions.savedPage'));
  }, [editorText, loadWikiSnapshot, preview, run, selectedPath, t]);

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
    await run('import-source', async () => {
      const call = await hostWikiImportSource({ sourcePath: path })
        .then((receipt) => waitForCall(receipt, 'wiki'))
        .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
      if (call.command !== 'import-source' || call.detail.operation !== 'import-source' || call.status === 'unknown') {
        throw new Error(t('actions.resultUnconfirmed'));
      }
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('actions.failed', { label: 'import-source' }));
      }
      if (call.detail.counts === null) throw new Error(t('actions.resultUnconfirmed'));
      setLastReceipt(summarizeSourceCallCounts(call.detail.counts, t('actions.importFileReceipt')));
      await loadWikiSnapshot();
    }, t('actions.importedSource'));
  }, [loadWikiSnapshot, run, t]);

  const pickAndImportSource = useCallback(async () => {
    const path = await pickLocalFile({
      title: t('actions.pickSourceFileTitle'),
      buttonLabel: t('actions.importFileButton'),
    });
    if (!path) return;
    await importSourcePath(path);
  }, [importSourcePath, t]);

  const importFolderPath = useCallback(async (path: string) => {
    await run('import-folder', async () => {
      const call = await hostWikiImportFolder({ folderPath: path })
        .then((receipt) => waitForCall(receipt, 'wiki'))
        .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
      if (call.command !== 'import-folder' || call.detail.operation !== 'import-folder' || call.status === 'unknown') {
        throw new Error(t('actions.resultUnconfirmed'));
      }
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('actions.failed', { label: 'import-folder' }));
      }
      if (call.detail.counts === null) throw new Error(t('actions.resultUnconfirmed'));
      setLastReceipt(summarizeSourceCallCounts(call.detail.counts, t('actions.importFolderReceipt')));
      await loadWikiSnapshot();
    }, t('actions.importedFolder'));
  }, [loadWikiSnapshot, run, t]);

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
    await run('refresh-sources', async () => {
      const call = await hostWikiRefreshSources()
        .then((receipt) => waitForCall(receipt, 'wiki'))
        .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
      if (call.command !== 'refresh-sources' || call.detail.operation !== 'refresh-sources' || call.status === 'unknown') {
        throw new Error(t('actions.resultUnconfirmed'));
      }
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('actions.failed', { label: 'refresh-sources' }));
      }
      if (call.detail.counts === null) throw new Error(t('actions.resultUnconfirmed'));
      setLastReceipt(summarizeSourceCallCounts(call.detail.counts, t('actions.refreshSourcesReceipt')));
      await loadWikiSnapshot();
    }, t('actions.refreshedSources'));
  }, [loadWikiSnapshot, run, t]);

  const loadSourceTasks = useCallback(async () => {
    await run('source-tasks', async () => {
      setSourceTasks(normalizeSourceTasks(await hostWikiSourceTasks()));
    });
  }, [run]);

  const cancelSourceTask = useCallback(async (sourcePath: string) => {
    await run('source-task-cancel', async () => {
      setSourceTasks(normalizeSourceTasks(await hostWikiCancelSourceTask({ sourcePath })));
    });
  }, [run]);

  const updateSourceWatchConfig = useCallback(async (payload: WikiSourceWatchConfigUpdate) => {
    await run('source-watch-config', async () => {
      const receipt = await hostWikiUpdateSourceWatchConfig(payload);
      setSourceWatchConfig(normalizeSourceWatchConfig(receipt.config));
    }, t('actions.updatedSourceWatch'));
  }, [run, t]);

  const researchTasksRef = useRef<readonly HostWikiResearchTask[]>([]);

  const readResearchTasks = useCallback(async (selectedProjectId: string, cancelled?: () => boolean) => {
    const receipt = await hostWikiResearchTasks({ projectId: selectedProjectId });
    if (cancelled?.() || projectIdRef.current !== selectedProjectId) return;
    const previous = researchTasksRef.current;
    researchTasksRef.current = receipt.tasks;
    setResearchTasks(receipt.tasks);
    const saved = receipt.tasks.some((task) => task.status === 'done' && task.savedPath
      && !previous.some((old) => old.id === task.id && old.status === 'done'));
    if (saved) {
      const [tree, reviews] = await Promise.all([
        loadDirectories([...loadedDirectories], selectedProjectId),
        hostWikiReviews({ projectId: selectedProjectId }),
      ]);
      if (cancelled?.() || projectIdRef.current !== selectedProjectId) return;
      setFiles(mergeFileItems([], tree.files));
      setReviewItems(normalizeReviews(reviews));
    }
  }, [loadedDirectories]);

  const loadResearchTasks = useCallback(async () => {
    if (!projectId) return;
    await run('research-tasks', () => readResearchTasks(projectId));
    setResearchPollVersion((version) => version + 1);
  }, [projectId, readResearchTasks, run]);

  const loadSearchConfig = useCallback(async () => {
    if (!projectId) return;
    await run('search-config', async () => {
      const receipt = await hostWikiSearchConfig({ projectId });
      if (projectIdRef.current === projectId) setSearchConfig(receipt);
    });
  }, [projectId, run]);

  useEffect(() => {
    let cancelled = false;
    researchTasksRef.current = [];
    if (!projectId) return;
    void Promise.all([hostWikiResearchTasks({ projectId }), hostWikiSearchConfig({ projectId })]).then(([tasks, config]) => {
      if (cancelled) return;
      researchTasksRef.current = tasks.tasks;
      setResearchTasks(tasks.tasks);
      setSearchConfig(config);
    }).catch(() => {
      if (!cancelled) toast.error(t('research.loadFailed', { defaultValue: '无法读取研究任务或搜索配置，请点击刷新重试。' }));
    });
    return () => { cancelled = true; };
  }, [projectId, t]);

  const hasActiveResearch = researchTasks.some((task) => task.projectId === projectId && !isTerminalResearchTask(task));
  useEffect(() => {
    if (!projectId || pageMode !== 'workspace' || !hasActiveResearch) return;
    let cancelled = false;
    let attempts = 0;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await readResearchTasks(projectId, () => cancelled);
        failures = 0;
      } catch {
        failures++;
      }
      if (cancelled || !researchTasksRef.current.some((task) => !isTerminalResearchTask(task))) return;
      if (++attempts >= 300 || failures >= 3) {
        toast.error(t('research.progressPaused', { defaultValue: '研究仍由后台执行，自动进度刷新已暂停；请点击研究页刷新继续查看。' }));
        return;
      }
      timer = setTimeout(() => { void poll(); }, 2000);
    };
    timer = setTimeout(() => { void poll(); }, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [hasActiveResearch, pageMode, projectId, readResearchTasks, researchPollVersion, t]);

  const startResearch = useCallback(async (input: HostWikiResearchInput) => {
    if (!projectId || projectIdRef.current !== projectId) throw new Error(t('actions.projectChanged', { defaultValue: '知识库已切换，请在当前知识库重试。' }));
    const modelRef = sourceWatchConfig.generationModelRef.trim();
    if (!modelRef) throw new Error(t('research.modelRequired', { defaultValue: '请先在来源设置中选择生成模型，再开始研究。' }));
    setBusy('research-start');
    try {
      await hostWikiStartResearch({ projectId, inputs: [input], modelRef });
      if (projectIdRef.current !== projectId) return;
      setActiveTab('research');
      setResearchPollVersion((version) => version + 1);
      void readResearchTasks(projectId).catch(() => {
        if (projectIdRef.current === projectId) toast.error(t('research.acceptedRefreshFailed', { defaultValue: '研究已提交，但任务列表读取失败，请刷新查看。' }));
      });
    } finally {
      if (projectIdRef.current === projectId) setBusy(null);
    }
  }, [projectId, readResearchTasks, sourceWatchConfig.generationModelRef, t]);

  const rerunResearch = useCallback(async (task: HostWikiResearchTask) => {
    if (!projectId) return;
    await run('research-rerun', async () => {
      const modelRef = sourceWatchConfig.generationModelRef.trim();
      if (!modelRef) throw new Error(t('research.modelRequired', { defaultValue: '请先在来源设置中选择生成模型，再开始研究。' }));
      await hostWikiRerunResearchTask({ projectId, taskId: task.id, modelRef });
      if (projectIdRef.current !== projectId) return;
      await readResearchTasks(projectId);
    });
  }, [projectId, readResearchTasks, run, sourceWatchConfig.generationModelRef, t]);

  const removeResearch = useCallback(async (taskId: string) => {
    if (!projectId) return;
    await run('research-remove', async () => {
      const receipt = await hostWikiRemoveResearchTask({ projectId, taskId });
      if (projectIdRef.current !== projectId) return;
      researchTasksRef.current = receipt.tasks;
      setResearchTasks(receipt.tasks);
    });
  }, [projectId, run]);

  const researchReview = useCallback((item: WikiReviewItem) => {
    void startResearch({ topic: reviewResearchTopic(item), searchQueries: item.searchQueries, sourceReviewId: item.id }).catch((error) => {
      if (projectIdRef.current === projectId) toast.error(error instanceof Error ? error.message : t('actions.failed', { label: 'research-start' }));
    });
  }, [projectId, startResearch, t]);

  const saveSearchConfig = useCallback(async (patch: HostWikiSearchConfigUpdate) => {
    if (!projectId) return;
    setBusy('search-config-save');
    try {
      const receipt = await hostWikiUpdateSearchConfig({ ...patch, projectId });
      if (projectIdRef.current === projectId) setSearchConfig(receipt);
    } finally {
      setBusy(null);
    }
  }, [projectId]);

  const testSearchConfig = useCallback(async (patch: HostWikiSearchConfigUpdate) => {
    setBusy('search-config-test');
    try {
      return await hostWikiTestSearchProvider({ projectId, config: patch });
    } finally {
      setBusy(null);
    }
  }, [projectId]);

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
    if (!selectedPath || preview.kind !== 'text' || preview.contentType !== 'markdown') return;
    await run('embed', async () => {
      const receipt = await hostWikiEmbedPage({ path: selectedPath });
      const call = await waitForCall(receipt, 'wiki');
      if (call.command !== 'embed-page' || call.detail.operation !== 'embed-page'
        || call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('actions.failed', { label: 'embed' }));
      }
    }, t('actions.embeddedPage'));
  }, [preview, run, selectedPath, t]);

  const changeWorkspaceTab = useCallback((tab: WikiWorkspaceTab) => {
    setActiveTab(tab);
    if (tab === 'sources') setSourceView('sources');
    if (tab === 'qa' && projectId) setQuestionProjectId(projectId);
  }, [projectId]);

  const activePanel = useMemo(() => {
    switch (activeTab) {
      case 'sources':
        return (
          <SourcesPanel
            files={sourceFiles}
            sourceTasks={sourceTasks}
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
        );
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
            onResearch={researchReview}
          />
        );
      case 'qa':
        return null;
      case 'lint':
        return projectId ? <LintPanel key={projectId} projectId={projectId} busy={busy} initialModelRef={sourceWatchConfig.generationModelRef} onOpenFile={readFile} onFilesChanged={onFilesChanged} /> : null;
      case 'maintenance':
        return projectId ? <MaintenancePanel key={projectId} projectId={projectId} projectName={currentProject?.title} busy={busy} onChanged={async () => { if (projectIdRef.current === projectId) await loadWikiSnapshot(); }} /> : null;
      case 'research':
        return (
          <ResearchPanel
            key={projectId}
            tasks={researchTasks.filter((task) => task.projectId === projectId)}
            busy={busy}
            onStart={(input) => { void startResearch(input).catch((error) => { if (projectIdRef.current === projectId) toast.error(error instanceof Error ? error.message : t('actions.failed', { label: 'research-start' })); }); }}
            onRerun={rerunResearch}
            onRemove={removeResearch}
            onOpenFile={readFile}
            onRefresh={loadResearchTasks}
          />
        );
      case 'search-settings':
        return <SearchSettingsPanel key={projectId} config={searchConfig && searchConfig.projectId === projectId ? searchConfig.config : null} busy={busy} onSave={saveSearchConfig} onTest={testSearchConfig} onRefresh={loadSearchConfig} />;
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
            {projectId ? <div className="min-h-0 overflow-auto border-t xl:border-l xl:border-t-0"><GraphInsightsPanel key={projectId} projectId={projectId} modelRef={sourceWatchConfig.generationModelRef} busy={busy} onLocateNodes={locateGraphNodes} onResearch={startResearch} /></div> : null}
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
    loadWikiSnapshot,
    onFilesChanged,
    onHistoryRestored,
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
    sourceView,
    sourceWatchConfig,
    updateSourceWatchConfig,
    dismissReview,
    clearResolvedReviews,
    createReviewPage,
    cancelSourceTask,
    loadResearchTasks,
    loadSearchConfig,
    openImageSource,
    projectId,
    researchReview,
    researchTasks,
    rerunResearch,
    removeResearch,
    saveSearchConfig,
    searchConfig,
    sourceImageIndex,
    startResearch,
    testSearchConfig,
    t,
  ]);

  if (pageMode === 'home' || !currentProject) {
    return (
      <LibraryHome
        status={status}
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
      currentProject={currentProject}
      files={files}
      expandedDirectories={expandedDirectories}
      selectedPath={selectedPath}
      activeTab={activeTab}
      sourceView={sourceView}
      busy={busy}
      questionPanel={questionProjectId === projectId ? <QuestionPanel key={projectId} projectId={currentProject.projectId} initialModelRef={sourceWatchConfig.generationModelRef} busy={busy} onOpenFile={(path) => readProjectFile(currentProject.projectId, path)} onSaved={onQuestionSaved} /> : undefined}
      activity={<ActivityBar status={status} sourceTasks={sourceTasks} busy={busy} onLoadSourceTasks={loadSourceTasks} onCancelSourceTask={cancelSourceTask} />}
      onTabChange={changeWorkspaceTab}
      onSourceViewChange={setSourceView}
      onBackHome={() => setPageMode('home')}
      onRefresh={refresh}
      onSelectFile={readFile}
      onToggleDirectory={toggleDirectory}
    >
      {activePanel}
    </LibraryWorkspace>
  );
}
