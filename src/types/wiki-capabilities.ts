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

export interface WikiInsightResearchInputReceipt {
  projectId: string;
  insightKey: string;
  topic: string;
  searchQueries: string[];
}
