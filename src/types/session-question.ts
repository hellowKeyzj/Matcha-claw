import { validateSessionIdentity, type SessionIdentity } from './desktop/runtime-address';

type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject { [key: string]: Json }
export interface SessionQuestionTarget {
  sessionId: string;
  instanceId: string;
  nativeRequestId: string;
}
export type SessionQuestionAnswer =
  | { type: 'askUserQuestion'; answer:
    | { action: 'answer'; answers: Record<string, string>; annotations?: Record<string, { preview?: string; notes?: string }> }
    | { action: 'decline'; message: string; interrupt?: boolean } }
  | { type: 'elicitation'; action: 'accept' | 'decline' | 'cancel'; content?: JsonObject };
export type SessionQuestionRequest =
  | { type: 'askUserQuestion'; questions: { question: string; header: string; options: { label: string; description: string; preview?: string }[]; multiSelect: boolean }[] }
  | { type: 'elicitationForm'; mcpServerName: string; message: string; requestedSchema?: JsonObject }
  | { type: 'elicitationUrl'; mcpServerName: string; message: string; url: string; elicitationId: string };
export type SessionQuestionAvailability = 'pending' | 'nativeCancelled' | 'instanceClosed' | 'serverRestarted';
export type SessionQuestionDelivery = 'notSent' | 'sending' | 'sent' | 'writeFailed' | 'unknown';
export interface SessionQuestionReceipt {
  target: SessionQuestionTarget;
  runId?: string;
  availability: SessionQuestionAvailability;
  delivery: SessionQuestionDelivery;
  nativeApplication: 'notSubmitted' | 'unknown';
  requestedAtMs: number;
  updatedAtMs: number;
  failure?: { code: number; kind: string };
}
export interface SessionQuestionView extends Omit<SessionQuestionReceipt, 'failure'> { request: SessionQuestionRequest }
export interface SessionQuestionListInput { sessionIdentity: SessionIdentity; endpointSessionId: string }
export interface SessionQuestionRespondInput { sessionIdentity: SessionIdentity; target: SessionQuestionTarget; answer: SessionQuestionAnswer }
export type SessionQuestionListResult =
  | { outcome: 'listed'; questions: SessionQuestionView[] }
  | { outcome: 'target_rejected' | 'unknown' | 'unsupported' | 'unavailable' };
export type SessionQuestionRespondResult =
  | { outcome: 'responded'; receipt: SessionQuestionReceipt }
  | { outcome: 'target_rejected' | 'unknown' | 'unavailable'; receipt?: SessionQuestionReceipt; responseAttemptDelivery?: SessionQuestionDelivery }
  | { outcome: 'unsupported' };

export function isSessionQuestionIdentity(value: unknown): value is SessionIdentity {
  if (validateSessionIdentity(value)) return false;
  const identity = value as SessionIdentity;
  return identity.endpoint.kind === 'native-runtime' && identity.endpoint.runtimeAdapterId === 'matcha-agent'
    && identity.endpoint.runtimeInstanceId === 'local';
}
export function isSessionQuestionListInput(value: unknown): value is SessionQuestionListInput {
  return record(value) && keys(value, ['sessionIdentity', 'endpointSessionId'])
    && isSessionQuestionIdentity(value.sessionIdentity) && text(value.endpointSessionId);
}
export function isSessionQuestionRespondInput(value: unknown): value is SessionQuestionRespondInput {
  return record(value) && keys(value, ['sessionIdentity', 'target', 'answer'])
    && isSessionQuestionIdentity(value.sessionIdentity) && target(value.target) && answer(value.answer);
}
export function decodeSessionQuestionListResult(value: unknown): SessionQuestionListResult | null {
  if (!record(value)) return null;
  if (value.outcome === 'listed') {
    return keys(value, ['outcome', 'questions']) && Array.isArray(value.questions) && value.questions.every(view)
      ? value as unknown as SessionQuestionListResult : null;
  }
  return keys(value, ['outcome']) && ['target_rejected', 'unknown', 'unsupported', 'unavailable'].includes(String(value.outcome))
    ? value as SessionQuestionListResult : null;
}
export function decodeSessionQuestionRespondResult(value: unknown): SessionQuestionRespondResult | null {
  if (!record(value)) return null;
  if (value.outcome === 'responded') return keys(value, ['outcome', 'receipt']) && receipt(value.receipt)
    && record(value.receipt) && value.receipt.delivery === 'sent'
    ? value as unknown as SessionQuestionRespondResult : null;
  if (value.outcome === 'unsupported') return keys(value, ['outcome']) ? value as SessionQuestionRespondResult : null;
  return keys(value, ['outcome'], ['receipt', 'responseAttemptDelivery'])
    && ['target_rejected', 'unknown', 'unavailable'].includes(String(value.outcome))
    && (value.receipt === undefined || receipt(value.receipt))
    && (value.responseAttemptDelivery === undefined || delivery(value.responseAttemptDelivery))
    ? value as unknown as SessionQuestionRespondResult : null;
}
function answer(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.type === 'elicitation') return keys(value, ['type', 'action'], ['content'])
    && ['accept', 'decline', 'cancel'].includes(String(value.action))
    && (value.content === undefined || (value.action === 'accept' && jsonObject(value.content)));
  if (value.type !== 'askUserQuestion' || !keys(value, ['type', 'answer']) || !record(value.answer)) return false;
  const result = value.answer;
  if (result.action === 'decline') return keys(result, ['action', 'message'], ['interrupt']) && questionText(result.message)
    && (result.interrupt === undefined || typeof result.interrupt === 'boolean');
  if (result.action !== 'answer' || !keys(result, ['action', 'answers'], ['annotations']) || !record(result.answers)) return false;
  const answers = result.answers;
  return Object.keys(answers).length >= 1 && Object.keys(answers).length <= 4
    && Object.entries(answers).every(([key, item]) => questionText(key) && questionText(item))
    && (result.annotations === undefined || (record(result.annotations) && Object.entries(result.annotations).every(([key, item]) =>
      Object.hasOwn(answers, key) && record(item) && keys(item, [], ['preview', 'notes'])
      && (item.preview === undefined || questionText(item.preview)) && (item.notes === undefined || questionText(item.notes)))));
}
function target(value: unknown): value is SessionQuestionTarget {
  return record(value) && keys(value, ['sessionId', 'instanceId', 'nativeRequestId'])
    && text(value.sessionId) && text(value.instanceId) && text(value.nativeRequestId);
}
function delivery(value: unknown): value is SessionQuestionDelivery {
  return ['notSent', 'sending', 'sent', 'writeFailed', 'unknown'].includes(String(value));
}
function receiptFields(value: Record<string, unknown>): boolean {
  return target(value.target) && (value.runId === undefined || text(value.runId))
    && ['pending', 'nativeCancelled', 'instanceClosed', 'serverRestarted'].includes(String(value.availability))
    && delivery(value.delivery) && value.nativeApplication === (value.delivery === 'notSent' || value.delivery === 'writeFailed' ? 'notSubmitted' : 'unknown')
    && timestamp(value.requestedAtMs) && timestamp(value.updatedAtMs);
}
function receipt(value: unknown): boolean {
  return record(value) && keys(value, ['target', 'availability', 'delivery', 'nativeApplication', 'requestedAtMs', 'updatedAtMs'], ['runId', 'failure'])
    && receiptFields(value) && (value.failure === undefined || (record(value.failure) && keys(value.failure, ['code', 'kind'])
      && typeof value.failure.code === 'number' && Number.isSafeInteger(value.failure.code)
      && typeof value.failure.kind === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value.failure.kind)));
}
function view(value: unknown): boolean {
  return record(value) && keys(value, ['target', 'request', 'availability', 'delivery', 'nativeApplication', 'requestedAtMs', 'updatedAtMs'], ['runId'])
    && receiptFields(value) && request(value.request);
}
function request(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.type === 'askUserQuestion') return keys(value, ['type', 'questions']) && Array.isArray(value.questions)
    && value.questions.length >= 1 && value.questions.length <= 4 && value.questions.every((item) => record(item)
      && keys(item, ['question', 'header', 'options', 'multiSelect']) && questionText(item.question) && questionText(item.header)
      && typeof item.multiSelect === 'boolean' && Array.isArray(item.options) && item.options.length >= 2 && item.options.length <= 4
      && item.options.every((option) => record(option)
        && keys(option, ['label', 'description'], ['preview']) && questionText(option.label) && questionText(option.description)
        && (option.preview === undefined || questionText(option.preview)))
      && new Set(item.options.map((option) => (option as Record<string, unknown>).label)).size === item.options.length)
    && new Set(value.questions.map((item) => (item as Record<string, unknown>).question)).size === value.questions.length;
  if (value.type === 'elicitationForm') return keys(value, ['type', 'mcpServerName', 'message'], ['requestedSchema'])
    && text(value.mcpServerName) && typeof value.message === 'string' && (value.requestedSchema === undefined || jsonObject(value.requestedSchema));
  return value.type === 'elicitationUrl' && keys(value, ['type', 'mcpServerName', 'message', 'url', 'elicitationId'])
    && text(value.mcpServerName) && typeof value.message === 'string' && text(value.url) && text(value.elicitationId);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && new TextEncoder().encode(value).length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function questionText(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\u0000') && new TextEncoder().encode(value).length <= 128 * 1024;
}
function timestamp(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function json(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) ? value.every(json) : jsonObject(value));
}
function jsonObject(value: unknown): value is JsonObject { return record(value) && Object.values(value).every(json); }
