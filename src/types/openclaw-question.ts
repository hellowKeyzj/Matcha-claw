import { validateSessionIdentity, type SessionIdentity } from './desktop/runtime-address';

export interface OpenClawQuestion {
  questionId: string;
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  isOther?: boolean;
}

export interface OpenClawPendingQuestionRecord {
  id: string;
  questions: OpenClawQuestion[];
  agentId: string;
  sessionKey: string;
  runId?: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: 'pending';
}

export interface OpenClawQuestionListInput {
  sessionIdentity: SessionIdentity;
}

export interface OpenClawQuestionListResult {
  questions: OpenClawPendingQuestionRecord[];
}

export interface OpenClawQuestionResolveInput extends OpenClawQuestionListInput {
  id: string;
  answers: { answers: Record<string, string[]> };
  resolvedBy?: string;
  resolutionId?: string;
}

export interface OpenClawQuestionResolveResult {
  status: 'answered';
  answers: { answers: Record<string, string[]> };
}

export function isOpenClawQuestionListInput(value: unknown): value is OpenClawQuestionListInput {
  return isRecord(value) && hasKeys(value, ['sessionIdentity'])
    && isOpenClawQuestionSessionIdentity(value.sessionIdentity);
}

export function isOpenClawQuestionSessionIdentity(value: unknown): value is SessionIdentity {
  if (validateSessionIdentity(value)) return false;
  const identity = value as SessionIdentity;
  return identity.endpoint.kind === 'native-runtime'
    && identity.endpoint.runtimeAdapterId === 'openclaw'
    && identity.endpoint.runtimeInstanceId === 'local';
}

export function isOpenClawQuestionResolveInput(value: unknown): value is OpenClawQuestionResolveInput {
  return isRecord(value) && hasKeys(value, ['sessionIdentity', 'id', 'answers'], ['resolvedBy', 'resolutionId'])
    && isOpenClawQuestionSessionIdentity(value.sessionIdentity) && isText(value.id)
    && isAnswers(value.answers)
    && (value.resolvedBy === undefined || isText(value.resolvedBy))
    && (value.resolutionId === undefined || (isText(value.resolutionId) && value.resolutionId.length <= 128));
}

export function decodeOpenClawQuestionListResult(value: unknown): OpenClawQuestionListResult | null {
  if (!isRecord(value) || !hasKeys(value, ['questions']) || !Array.isArray(value.questions)
    || !value.questions.every(isPendingRecord)) return null;
  return value as unknown as OpenClawQuestionListResult;
}

export function decodeOpenClawQuestionResolveResult(value: unknown): OpenClawQuestionResolveResult | null {
  return isRecord(value) && hasKeys(value, ['status', 'answers']) && value.status === 'answered'
    && isAnswers(value.answers) ? value as unknown as OpenClawQuestionResolveResult : null;
}

function isPendingRecord(value: unknown): boolean {
  return isRecord(value)
    && hasKeys(value, ['id', 'questions', 'agentId', 'sessionKey', 'createdAtMs', 'expiresAtMs', 'status'], ['runId'])
    && isText(value.id) && isText(value.agentId) && isText(value.sessionKey)
    && (value.runId === undefined || isText(value.runId))
    && isTimestamp(value.createdAtMs) && isTimestamp(value.expiresAtMs) && value.status === 'pending'
    && Array.isArray(value.questions) && value.questions.length >= 1 && value.questions.length <= 3
    && value.questions.every(isQuestion)
    && new Set(value.questions.map((question) => question.questionId)).size === value.questions.length;
}

function isQuestion(value: unknown): value is OpenClawQuestion {
  return isRecord(value) && hasKeys(value, ['questionId', 'header', 'question', 'options'], ['multiSelect', 'isOther'])
    && typeof value.questionId === 'string' && /^[a-z][a-z0-9_]*$/.test(value.questionId)
    && typeof value.header === 'string' && isQuestionText(value.question)
    && Array.isArray(value.options) && value.options.length <= 4 && value.options.length !== 1
    && value.options.every((option) => isRecord(option) && hasKeys(option, ['label'], ['description'])
      && isQuestionText(option.label) && (option.description === undefined || typeof option.description === 'string'))
    && (value.multiSelect === undefined || typeof value.multiSelect === 'boolean')
    && (value.isOther === undefined || typeof value.isOther === 'boolean');
}

function isAnswers(value: unknown): boolean {
  return isRecord(value) && hasKeys(value, ['answers']) && isRecord(value.answers)
    && Object.entries(value.answers).every(([key, answers]) => /^[a-z][a-z0-9_]*$/.test(key)
      && Array.isArray(answers) && answers.every((answer) => typeof answer === 'string'));
}

function isQuestionText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTimestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
