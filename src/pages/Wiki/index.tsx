import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { pickLocalDirectory, pickLocalFile } from '@/services/local-path-picker';
import { waitForCall } from '@/lib/call-log-await';
import { LibraryHome } from './components/LibraryHome';
import { LibraryWorkspace } from './components/LibraryWorkspace';
import { ActivityBar } from './components/ActivityBar';
import { GraphPanel } from './components/GraphPanel';
import { SearchPanel } from './components/SearchPanel';
import { SourcesPanel } from './components/SourcesPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { WikiContentPanel, type WikiContentPreview } from './components/WikiContentPanel';
import { classifyWikiPath, isUnsupportedWikiSourcePreview, supportsWikiBinaryPreview, supportsWikiTextPreview, wikiPreviewErrorKey } from './preview';
import { resolveWikiMarkdownImage } from './wiki-media';
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

async function loadDirectories(directories: readonly string[]): Promise<LoadedWikiFiles> {
  const results = await Promise.allSettled(directories.map(async (directory) => {
    const files = normalizeFiles(await hostWikiFiles({ directory }));
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
  const [editorText, setEditorText] = useState('');
  const [openPath, setOpenPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [lastReceipt, setLastReceipt] = useState<WikiReceiptSummary | null>(null);
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<WikiSearchResult | null>(null);
  const [contextResult, setContextResult] = useState<WikiSearchResult | null>(null);
  const [graph, setGraph] = useState<WikiGraphResult | null>(null);
  const [activeTab, setActiveTab] = useState<WikiWorkspaceTab>('wiki');
  const [sourceView, setSourceView] = useState<WikiSourceView>('sources');
  const [busy, setBusy] = useState<string | null>('load');

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

  const loadWikiSnapshot = useCallback(async () => {
    const [statusResult, projectsResult, templatesResult, currentProjectResult, fileTreeResult, sourceFilesResult, sourceWatchResult, sourceTasksResult, reviewsResult] = await Promise.allSettled([
      hostWikiStatus(),
      hostWikiProjects(),
      hostWikiProjectTemplates(),
      hostWikiCurrentProject(),
      loadDirectories(WIKI_TREE_ROOT_DIRECTORIES),
      hostWikiSourceFiles(),
      hostWikiSourceWatchConfig(),
      hostWikiSourceTasks(),
      hostWikiReviews(),
    ]);

    const nextStatus = statusResult.status === 'fulfilled' ? normalizeStatus(statusResult.value) : EMPTY_STATUS;
    const nextProjects = projectsResult.status === 'fulfilled' ? normalizeProjects(projectsResult.value) : [];
    const nextTemplates = templatesResult.status === 'fulfilled' ? normalizeProjectTemplates(templatesResult.value) : [];
    const nextCurrentProject = currentProjectResult.status === 'fulfilled'
      ? currentProjectFromPayload(currentProjectResult.value, nextStatus, nextProjects)
      : currentProjectFromPayload(null, nextStatus, nextProjects);

    const nextFileTree = fileTreeResult.status === 'fulfilled' ? fileTreeResult.value : { files: [], directories: [] };
    const nextSourceFiles = sourceFilesResult.status === 'fulfilled' ? normalizeFiles(sourceFilesResult.value) : [];

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
    await run('load', loadWikiSnapshot);
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
      await hostWikiCreateProject({ path, name: projectName.trim() || undefined, templateId: selectedTemplateId });
      await loadWikiSnapshot();
      setPageMode('workspace');
    }, t('actions.createdLibrary'));
  }, [loadWikiSnapshot, openPath, projectName, run, selectedTemplateId, t]);

  const selectProject = useCallback(async (project: WikiProject) => {
    await run('open', async () => {
      await hostWikiOpenProject({ path: project.rootPath, name: project.title });
      await loadWikiSnapshot();
      setPageMode('workspace');
    }, t('actions.switchedLibrary'));
  }, [loadWikiSnapshot, run, t]);

  const readFile = useCallback(async (path: string) => {
    await run('read', async () => {
      const meta = classifyWikiPath(path);
      setSelectedPath(path);
      setPreview({ kind: 'empty' });
      setEditorText('');
      setActiveTab('wiki');

      if (supportsWikiTextPreview(meta.contentType, meta.ext)) {
        const result = normalizeRead(await hostWikiReadFile({ path }), path);
        setSelectedPath(result.path);
        setEditorText(result.content);
        setPreview({ kind: 'text', path: result.path, content: result.content, ...meta });
        return;
      }

      if (supportsWikiBinaryPreview(meta.contentType)) {
        const result = await hostWikiReadBinaryFile({ path, maxBytes: WIKI_PREVIEW_MAX_BYTES });
        setPreview(result.ok && result.data
          ? { kind: 'binary', path, name: result.name ?? path, data: result.data, size: result.size ?? 0, ...meta }
          : { kind: 'error', path, message: t(wikiPreviewErrorKey(result.error)), ...meta });
        return;
      }

      try {
        const result = normalizeRead(await hostWikiReadSourcePreview({ path }), path);
        setSelectedPath(result.path);
        setPreview({ kind: 'source', path: result.path, content: result.content, ...meta });
      } catch (error) {
        setPreview(isUnsupportedWikiSourcePreview(error)
          ? { kind: 'unsupported', path, ...meta }
          : { kind: 'error', path, message: t(wikiPreviewErrorKey(undefined)), ...meta });
      }
    });
  }, [run, t]);

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
    await run('graph', async () => {
      setGraph(normalizeGraph(await hostWikiGraph()));
    });
  }, [run]);

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
  }, []);

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
          />
        );
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
          />
        );
      case 'graph':
        return (
          <GraphPanel
            graph={graph}
            selectedPath={selectedPath}
            busy={busy}
            onLoadGraph={loadGraph}
            onEmbedPage={embedPage}
            onOpenNode={readFile}
          />
        );
      case 'wiki':
        return (
          <WikiContentPanel
            selectedPath={selectedPath}
            preview={preview}
            editorText={editorText}
            busy={busy}
            resolveImageSrc={resolveWikiMarkdownImage}
            onEditorTextChange={setEditorText}
            onSave={saveFile}
            onEmbedPage={embedPage}
          />
        );
    }
  }, [
    activeTab,
    busy,
    contextResult,
    deleteSourceAtPath,
    editorText,
    embedPage,
    graph,
    lastReceipt,
    loadGraph,
    loadReviews,
    loadSourceTasks,
    pickAndImportFolder,
    pickAndImportSource,
    preview,
    query,
    readFile,
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
