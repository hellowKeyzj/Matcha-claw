export type WikiSelectionIntent = 'ask' | 'edit';

export interface WikiSelectionSnapshot {
  prefix: string;
  selectedText: string;
  suffix: string;
  sourceMapped: boolean;
}

export interface WikiSelectionTurn {
  question: string;
  answer: string;
}

export interface WikiSelectionReference {
  path: string;
  title: string;
  snippet: string;
}

export interface WikiSelectionTask {
  projectId: string;
  taskId: string;
  relativePath: string;
  intent: WikiSelectionIntent;
  status: 'queued' | 'retrieving' | 'generating' | 'done' | 'cancelled' | 'failed';
  content: string;
  references: WikiSelectionReference[];
  error: string | null;
}

export interface WikiSelectionInput {
  projectId?: string;
  taskId: string;
  relativePath: string;
  intent: WikiSelectionIntent;
  instruction: string;
  selection: WikiSelectionSnapshot;
  history: WikiSelectionTurn[];
  modelRef?: string;
}

export interface WikiSelectionApplyReceipt {
  projectId: string;
  relativePath: string;
  content: string;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function decodeWikiSelectionTask(value: unknown): WikiSelectionTask {
  if (!record(value) || !exact(value, ['projectId', 'taskId', 'relativePath', 'intent', 'status', 'content', 'references', 'error'])
    || typeof value.projectId !== 'string' || typeof value.taskId !== 'string' || typeof value.relativePath !== 'string'
    || (value.intent !== 'ask' && value.intent !== 'edit')
    || typeof value.status !== 'string' || !['queued', 'retrieving', 'generating', 'done', 'cancelled', 'failed'].includes(value.status)
    || typeof value.content !== 'string' || (value.error !== null && typeof value.error !== 'string')
    || !Array.isArray(value.references) || !value.references.every((reference) => record(reference)
      && exact(reference, ['path', 'title', 'snippet']) && typeof reference.path === 'string'
      && typeof reference.title === 'string' && typeof reference.snippet === 'string')) {
    throw new Error('Wiki selection result is invalid');
  }
  return value as unknown as WikiSelectionTask;
}

export function decodeWikiSelectionApplyReceipt(value: unknown): WikiSelectionApplyReceipt {
  if (!record(value) || !exact(value, ['projectId', 'relativePath', 'content']) || typeof value.projectId !== 'string'
    || typeof value.relativePath !== 'string' || typeof value.content !== 'string') {
    throw new Error('Wiki selection apply result is invalid');
  }
  return value as unknown as WikiSelectionApplyReceipt;
}
