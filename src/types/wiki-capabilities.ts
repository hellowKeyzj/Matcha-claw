export interface WikiDuplicateGroup {
  slugs: string[];
  reason: string;
  confidence: string;
}

export interface WikiDedupDetection {
  projectId: string;
  groups: WikiDuplicateGroup[];
}

export interface WikiDedupTask {
  id: string;
  projectId: string;
  group: WikiDuplicateGroup;
  canonicalSlug: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  addedAt: number;
  error: string | null;
  retryCount: number;
  paused: boolean;
}

export interface WikiDedupState {
  projectId: string;
  tasks: WikiDedupTask[];
}

export interface WikiPageLink {
  title: string;
  path?: string;
  snippet?: string;
}

export interface WikiPageLinks {
  projectId: string;
  outgoing: WikiPageLink[];
  backlinks: WikiPageLink[];
  missing: WikiPageLink[];
}

export interface WikiMissingPageReceipt {
  projectId: string;
  path: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isWikiDuplicateGroup(value: unknown): value is WikiDuplicateGroup {
  return record(value) && exact(value, ['slugs', 'reason', 'confidence'])
    && Array.isArray(value.slugs) && value.slugs.length >= 2 && value.slugs.every((slug) => typeof slug === 'string' && slug.length > 0)
    && typeof value.reason === 'string' && typeof value.confidence === 'string';
}

export function decodeWikiDedupState(value: unknown): WikiDedupState {
  if (!record(value) || !exact(value, ['projectId', 'tasks']) || typeof value.projectId !== 'string'
    || !Array.isArray(value.tasks) || !value.tasks.every((task) => record(task)
      && exact(task, ['id', 'projectId', 'group', 'canonicalSlug', 'status', 'addedAt', 'error', 'retryCount', 'paused'])
      && typeof task.id === 'string' && task.projectId === value.projectId && isWikiDuplicateGroup(task.group)
      && typeof task.canonicalSlug === 'string' && task.group.slugs.includes(task.canonicalSlug)
      && typeof task.status === 'string' && ['pending', 'processing', 'done', 'failed'].includes(task.status)
      && typeof task.addedAt === 'number' && Number.isSafeInteger(task.addedAt) && task.addedAt >= 0
      && (task.error === null || typeof task.error === 'string')
      && typeof task.retryCount === 'number' && Number.isSafeInteger(task.retryCount) && task.retryCount >= 0
      && typeof task.paused === 'boolean')) throw new Error('Invalid Wiki dedup state');
  return value as unknown as WikiDedupState;
}

export function decodeWikiPageLinks(value: unknown): WikiPageLinks {
  const link = (item: unknown): item is WikiPageLink => record(item)
    && exact(item, ['title', ...(Object.hasOwn(item, 'path') ? ['path'] : []), ...(Object.hasOwn(item, 'snippet') ? ['snippet'] : [])])
    && typeof item.title === 'string'
    && (!Object.hasOwn(item, 'path') || (typeof item.path === 'string' && item.path.length > 0
      && !item.path.includes('\\') && !/^[a-z]:/i.test(item.path) && !item.path.startsWith('/')
      && !item.path.includes('\0') && item.path.split('/').every((part) => part !== '..')))
    && (!Object.hasOwn(item, 'snippet') || typeof item.snippet === 'string');
  if (!record(value) || !exact(value, ['projectId', 'outgoing', 'backlinks', 'missing']) || typeof value.projectId !== 'string'
    || !Array.isArray(value.outgoing) || !value.outgoing.every(link)
    || !Array.isArray(value.backlinks) || !value.backlinks.every(link)
    || !Array.isArray(value.missing) || !value.missing.every(link)) throw new Error('Invalid Wiki page links');
  return value as unknown as WikiPageLinks;
}

export interface WikiHistoryEntry {
  id: string;
  path: string;
  timestamp: number;
  author: string;
  tool: string;
  content: string;
}

export interface WikiHistoryReceipt {
  projectId: string;
  path: string;
  entries: WikiHistoryEntry[];
}

export interface WikiHistoryConfig {
  enabled: boolean;
  maxVersionsPerFile: number;
}

export interface WikiHistoryStats {
  bytes: number;
  files: number;
  entries: number;
}

export interface WikiRebuildIndexReceipt {
  projectId: string;
  pages: number;
  groups: number;
}

export interface WikiQuestionHistory {
  role: 'user' | 'assistant';
  content: string;
}

export interface WikiQuestionInput {
  projectId?: string;
  taskId: string;
  modelRef: string;
  question: string;
  history: WikiQuestionHistory[];
}

export interface WikiQuestionReference {
  title: string;
  path: string;
  snippet: string;
  graphRelatedTo: string[];
}

export type WikiQuestionStatus = 'queued' | 'retrieving' | 'answering' | 'done' | 'cancelled' | 'error';

export interface WikiQuestionTask {
  id: string;
  projectId: string;
  question: string;
  modelRef: string;
  status: WikiQuestionStatus;
  answer: string;
  references: WikiQuestionReference[];
  error: string | null;
  savedPath: string | null;
  revision: number;
}

export interface WikiQuestionTaskReceipt {
  projectId: string;
  task: WikiQuestionTask;
}

export interface WikiQuestionSaveReceipt {
  projectId: string;
  savedPath: string;
}

export interface WikiLintConfig {
  ignoreOrphan: boolean;
  ignoreNoOutlinks: boolean;
  ignorePages: string[];
}

export interface WikiLintFinding {
  id: string;
  type: 'orphan' | 'broken-link' | 'no-outlinks' | 'semantic';
  severity: 'info' | 'warning';
  page: string;
  detail: string;
  affectedPages: string[];
  brokenTarget: string | null;
  suggestedTarget: string | null;
  suggestedSource: string | null;
  createdAt: number;
}

export interface WikiLintRunInput {
  projectId?: string;
  semantic?: boolean;
  modelRef?: string;
  outputLanguage?: string;
  config?: WikiLintConfig;
}

export interface WikiLintState {
  projectId: string;
  taskId: string | null;
  phase: 'idle' | 'reading' | 'structural' | 'semantic' | 'done' | 'cancelled' | 'error';
  completed: number;
  total: number;
  items: WikiLintFinding[];
  error: string | null;
}

export interface WikiLintFixReceipt {
  projectId: string;
  fixedIds: string[];
  reviewedIds: string[];
  writtenPages: string[];
  deletedPages: string[];
  failures: { id: string; message: string }[];
}

export interface WikiReindexState {
  projectId: string;
  taskId: string | null;
  status: 'idle' | 'running' | 'done' | 'error';
  phase: 'preparing' | 'writing' | null;
  done: number;
  total: number;
  count: number;
  message: string | null;
}

export interface WikiGraphInsightsReceipt {
  projectId: string;
  surprisingConnections: {
    key: string;
    sourceId: string;
    targetId: string;
    score: number;
    reasons: string[];
  }[];
  knowledgeGaps: {
    key: string;
    type: 'isolated-node' | 'sparse-community' | 'bridge-node';
    title: string;
    description: string;
    nodeIds: string[];
    suggestion: string;
  }[];
  dismissedKeys: string[];
}
