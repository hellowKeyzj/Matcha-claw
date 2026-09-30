import type { WikiSourceCallCounts } from '@/types/call-log/wiki';
import type { WikiDeleteSourceResult } from '@/types/wiki-call-result';

export type WikiSourceWatchConfig = Readonly<{
  enabled: boolean;
  autoIngest: boolean;
  outputLanguage: string;
  generationModelRef: string;
  captionModelRef: string;
  captionEnabled: boolean;
  captionConcurrency: number;
  mineruEnabled: boolean;
  mineruBackend: string;
  mineruTokenConfigured: boolean;
  mineruModelVersion: string;
  mineruLocalEndpoint: string;
  mineruLocalTokenConfigured: boolean;
  mineruLocalBackend: string;
  mineruLocalEffort: string;
  mineruLocalParseMethod: string;
  mineruLocalLanguage: string;
  mineruLocalFormulaEnabled: boolean;
  mineruLocalTableEnabled: boolean;
  mineruLocalImageAnalysis: boolean;
  mineruLocalServerUrl: string;
}>;

export type WikiSourceWatchConfigUpdate = Readonly<{
  enabled?: boolean;
  autoIngest?: boolean;
  outputLanguage?: string;
  generationModelRef?: string | null;
  captionModelRef?: string | null;
  captionEnabled?: boolean;
  captionConcurrency?: number;
  mineruEnabled?: boolean;
  mineruBackend?: string;
  mineruToken?: string;
  mineruModelVersion?: string;
  mineruLocalEndpoint?: string;
  mineruLocalToken?: string;
  mineruLocalBackend?: string;
  mineruLocalEffort?: string;
  mineruLocalParseMethod?: string;
  mineruLocalLanguage?: string;
  mineruLocalFormulaEnabled?: boolean;
  mineruLocalTableEnabled?: boolean;
  mineruLocalImageAnalysis?: boolean;
  mineruLocalServerUrl?: string;
}>;

export type WikiReviewOption = Readonly<{
  label: string;
  action: string;
}>;

export type WikiReviewItem = Readonly<{
  id: string;
  type: 'contradiction' | 'duplicate' | 'missing-page' | 'confirm' | 'suggestion';
  title: string;
  description: string;
  sourcePath: string | null;
  affectedPages: readonly string[];
  searchQueries: readonly string[];
  options: readonly WikiReviewOption[];
  resolved: boolean;
  resolvedAction: string | null;
  createdAt: number;
}>;

export type WikiProject = Readonly<{
  projectId: string;
  title: string;
  rootPath: string;
  isCurrent: boolean;
  openedAtMs: number;
}>;

export type WikiProjectTemplate = Readonly<{
  id: string;
  name: string;
  description: string;
  icon: string;
}>;

export type WikiStatus = Readonly<{
  stateRoot: string;
  currentProject: WikiProject | null;
  projectCount: number;
  pendingChangeCount: number;
}>;

export type WikiFileItem = Readonly<{
  path: string;
  label: string;
  isDirectory: boolean;
  size: number;
  modifiedAtMs: number;
}>;

export type WikiReadResult = Readonly<{
  path: string;
  content: string;
}>;

export type WikiSourceTask = Readonly<{
  id: string;
  sourcePath: string;
  kind: string;
  status: string;
  updatedAtMs: number;
  retryCount: number;
  error: string | null;
  stage: string | null;
  progress: number | null;
  cancelRequestedAtMs: number | null;
}>;

export type WikiSearchHit = Readonly<{
  relativePath: string;
  title: string;
  score: number;
  snippets: readonly string[];
}>;

export type WikiSearchResult = Readonly<{
  query: string;
  hits: readonly WikiSearchHit[];
}>;

export type WikiGraphNode = Readonly<{
  id: string;
  label: string;
  kind: string;
}>;

export type WikiGraphEdge = Readonly<{
  source: string;
  target: string;
  label: string;
}>;

export type WikiGraphResult = Readonly<{
  nodes: readonly WikiGraphNode[];
  edges: readonly WikiGraphEdge[];
}>;

export type WikiReceiptSummary = Readonly<{
  imported: number;
  deleted: number;
  moved: number;
  skipped: number;
  written: number;
  label: string;
}>;

export type WikiWorkspaceTab = 'wiki' | 'sources' | 'review' | 'search' | 'graph';
export type WikiSourceView = 'sources' | 'settings';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function pickString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

function firstArray(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
}

function toProject(value: unknown): WikiProject | null {
  if (!isRecord(value)) return null;
  const projectId = pickString(value, ['projectId', 'id']);
  const rootPath = pickString(value, ['rootPath', 'path', 'root']);
  if (!projectId || !rootPath) return null;
  return {
    projectId,
    title: pickString(value, ['title', 'name']) ?? rootPath.split(/[\\/]/).pop() ?? rootPath,
    rootPath,
    isCurrent: value.isCurrent === true,
    openedAtMs: pickNumber(value, ['openedAtMs', 'updatedAtMs']),
  };
}

export function normalizeStatus(value: unknown): WikiStatus {
  const record = isRecord(value) ? value : {};
  const currentProject = toProject(record.currentProject);
  return {
    stateRoot: pickString(record, ['stateRoot']) ?? '',
    currentProject,
    projectCount: pickNumber(record, ['projectCount']),
    pendingChangeCount: pickNumber(record, ['pendingChangeCount']),
  };
}

export function normalizeProjects(value: unknown): readonly WikiProject[] {
  return firstArray(value, ['projects']).map(toProject).filter((project): project is WikiProject => project !== null);
}

export function normalizeProjectTemplates(value: unknown): readonly WikiProjectTemplate[] {
  return firstArray(value, ['templates']).map((template) => {
    if (!isRecord(template)) return null;
    const id = pickString(template, ['id']);
    if (!id) return null;
    return {
      id,
      name: pickString(template, ['name']) ?? id,
      description: pickString(template, ['description']) ?? '',
      icon: pickString(template, ['icon']) ?? '📚',
    } satisfies WikiProjectTemplate;
  }).filter((template): template is WikiProjectTemplate => template !== null);
}

export function currentProjectFromPayload(value: unknown, status: WikiStatus, projects: readonly WikiProject[]): WikiProject | null {
  const direct = isRecord(value) ? toProject(value.project) : null;
  return direct ?? status.currentProject ?? projects.find((project) => project.isCurrent) ?? null;
}

export function normalizeFiles(value: unknown): readonly WikiFileItem[] {
  return firstArray(value, ['entries', 'files', 'items', 'children'])
    .map((entry) => {
      if (typeof entry === 'string') {
        return {
          path: entry,
          label: entry.split(/[\\/]/).pop() || entry,
          isDirectory: false,
          size: 0,
          modifiedAtMs: 0,
        } satisfies WikiFileItem;
      }
      if (!isRecord(entry)) return null;
      const path = pickString(entry, ['relativePath', 'relative_path', 'path', 'id', 'name']);
      if (!path) return null;
      return {
        path,
        label: pickString(entry, ['label', 'display', 'name']) ?? path.split(/[\\/]/).pop() ?? path,
        isDirectory: entry.isDirectory === true || entry.kind === 'directory' || entry.type === 'directory',
        size: pickNumber(entry, ['size']),
        modifiedAtMs: pickNumber(entry, ['modifiedAtMs', 'modified_at_ms', 'mtimeMs']),
      } satisfies WikiFileItem;
    })
    .filter((entry): entry is WikiFileItem => entry !== null)
    .sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.path.localeCompare(right.path));
}

export function normalizeRead(value: unknown, fallbackPath: string): WikiReadResult {
  if (isRecord(value)) {
    return {
      path: pickString(value, ['relativePath', 'relative_path', 'path']) ?? fallbackPath,
      content: typeof value.content === 'string' ? value.content : '',
    };
  }
  return { path: fallbackPath, content: typeof value === 'string' ? value : '' };
}

export function normalizeSourceWatchConfig(value: unknown): WikiSourceWatchConfig {
  const record = isRecord(value) ? value : {};
  return {
    enabled: record.enabled === true,
    autoIngest: record.autoIngest === true,
    outputLanguage: pickString(record, ['outputLanguage']) ?? 'auto',
    generationModelRef: pickString(record, ['generationModelRef']) ?? '',
    captionModelRef: pickString(record, ['captionModelRef']) ?? '',
    captionEnabled: record.captionEnabled === true,
    captionConcurrency: Math.max(1, Math.min(16, pickNumber(record, ['captionConcurrency']) || 4)),
    mineruEnabled: record.mineruEnabled === true,
    mineruBackend: pickString(record, ['mineruBackend']) ?? 'cloud',
    mineruTokenConfigured: record.mineruTokenConfigured === true,
    mineruModelVersion: pickString(record, ['mineruModelVersion']) ?? 'vlm',
    mineruLocalEndpoint: pickString(record, ['mineruLocalEndpoint']) ?? 'http://127.0.0.1:8000',
    mineruLocalTokenConfigured: record.mineruLocalTokenConfigured === true,
    mineruLocalBackend: pickString(record, ['mineruLocalBackend']) ?? 'hybrid-engine',
    mineruLocalEffort: pickString(record, ['mineruLocalEffort']) ?? 'medium',
    mineruLocalParseMethod: pickString(record, ['mineruLocalParseMethod']) ?? 'auto',
    mineruLocalLanguage: pickString(record, ['mineruLocalLanguage']) ?? 'ch',
    mineruLocalFormulaEnabled: record.mineruLocalFormulaEnabled !== false,
    mineruLocalTableEnabled: record.mineruLocalTableEnabled !== false,
    mineruLocalImageAnalysis: record.mineruLocalImageAnalysis !== false,
    mineruLocalServerUrl: pickString(record, ['mineruLocalServerUrl']) ?? '',
  };
}

export function normalizeReviews(value: unknown): readonly WikiReviewItem[] {
  const items: WikiReviewItem[] = [];
  for (const item of firstArray(value, ['items'])) {
    if (!isRecord(item)) continue;
    const id = pickString(item, ['id']);
    const type = pickString(item, ['type']);
    const title = pickString(item, ['title']);
    if (!id || !title || !isReviewType(type)) continue;
    items.push({
      id,
      type,
      title,
      description: typeof item.description === 'string' ? item.description : '',
      sourcePath: pickString(item, ['sourcePath']),
      affectedPages: stringArray(item.affectedPages),
      searchQueries: stringArray(item.searchQueries),
      options: firstArray(item, ['options']).flatMap((option): WikiReviewOption[] => {
        if (!isRecord(option)) return [];
        const label = pickString(option, ['label']);
        const action = pickString(option, ['action']);
        return label && action ? [{ label, action }] : [];
      }),
      resolved: item.resolved === true,
      resolvedAction: pickString(item, ['resolvedAction']),
      createdAt: pickNumber(item, ['createdAt']),
    });
  }
  return items.sort((left, right) => Number(left.resolved) - Number(right.resolved) || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function isReviewType(value: string | null): value is WikiReviewItem['type'] {
  return value === 'contradiction' || value === 'duplicate' || value === 'missing-page' || value === 'confirm' || value === 'suggestion';
}

export function normalizeSourceTasks(value: unknown): readonly WikiSourceTask[] {
  return firstArray(value, ['tasks'])
    .map((task) => {
      if (!isRecord(task)) return null;
      const id = pickString(task, ['id']) ?? pickString(task, ['sourcePath', 'path']);
      const sourcePath = pickString(task, ['sourcePath', 'path']);
      if (!id || !sourcePath) return null;
      return {
        id,
        sourcePath,
        kind: pickString(task, ['kind']) ?? 'unknown',
        status: pickString(task, ['status']) ?? 'unknown',
        updatedAtMs: pickNumber(task, ['updatedAtMs', 'updated_at_ms', 'addedAtMs', 'added_at_ms']),
        retryCount: pickNumber(task, ['retryCount', 'retry_count']),
        error: pickString(task, ['error']),
        stage: pickString(task, ['stage']),
        progress: typeof task.progress === 'number' && Number.isFinite(task.progress) ? Math.max(0, Math.min(100, task.progress)) : null,
        cancelRequestedAtMs: pickNumber(task, ['cancelRequestedAtMs', 'cancel_requested_at_ms']) || null,
      } satisfies WikiSourceTask;
    })
    .filter((task): task is WikiSourceTask => task !== null)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function normalizeSearch(value: unknown): WikiSearchResult {
  const record = isRecord(value) ? value : {};
  const hits = firstArray(record, ['hits', 'results']).flatMap((hit): WikiSearchHit[] => {
    if (!isRecord(hit)) return [];
    const relativePath = pickString(hit, ['relativePath', 'path']);
    if (!relativePath) return [];
    const snippets = firstArray(hit, ['snippets']).filter((snippet): snippet is string => typeof snippet === 'string');
    return [{
      relativePath,
      title: pickString(hit, ['title', 'label', 'name']) ?? relativePath,
      score: pickNumber(hit, ['score']),
      snippets,
    }];
  });
  return { query: pickString(record, ['query']) ?? '', hits };
}

export function normalizeGraph(value: unknown): WikiGraphResult {
  const record = isRecord(value) ? value : {};
  const nodes = firstArray(record, ['nodes']).map((node) => {
    if (!isRecord(node)) return null;
    const id = pickString(node, ['id', 'path', 'relativePath']);
    if (!id) return null;
    return {
      id,
      label: pickString(node, ['label', 'title', 'name']) ?? id,
      kind: pickString(node, ['kind', 'type']) ?? 'page',
    } satisfies WikiGraphNode;
  }).filter((node): node is WikiGraphNode => node !== null);
  const edges = firstArray(record, ['edges', 'links']).map((edge) => {
    if (!isRecord(edge)) return null;
    const source = pickString(edge, ['source', 'from']);
    const target = pickString(edge, ['target', 'to']);
    if (!source || !target) return null;
    return {
      source,
      target,
      label: pickString(edge, ['label', 'kind', 'type']) ?? 'link',
    } satisfies WikiGraphEdge;
  }).filter((edge): edge is WikiGraphEdge => edge !== null);
  return { nodes, edges };
}

export function summarizeSourceCallCounts(counts: WikiSourceCallCounts, label: string): WikiReceiptSummary {
  return { ...counts, written: 0, label };
}

export function summarizeDeleteSourceResult(result: WikiDeleteSourceResult, label: string): WikiReceiptSummary {
  return { label, imported: 0, deleted: result.deletedPages.length, moved: 0, skipped: 0, written: 0 };
}

export function formatDateTime(ms: number, fallback = ''): string {
  if (!ms) return fallback;
  return new Date(ms).toLocaleString();
}

export function formatFileSize(size: number): string {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
