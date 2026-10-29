import { sha256 } from '@noble/hashes/sha2';
import i18n from '@/i18n';
import { hostApiFetchWithFailure } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import type { StorageOpenInput, StorageOpenResult } from '@/types/world-storage';
export type { StorageOpenInput, StorageOpenResult } from '@/types/world-storage';
import type { WorldAccessCommitIntent, WorldAccessImportResult, WorldAccessIntent, WorldAccessPrepareResult } from '@/types/world-access';
import type {
  WorldEvaluationCommitIntent, WorldEvaluationCommitResult, WorldEvaluationIntent,
  WorldEvaluationPrepareResult, WorldEvaluationStatusResult,
} from '@/types/world-evaluation';
export type { InitialWorldIssue } from '@/types/world-initial';
import type {
  CommandResult, Failure, OperationRequest, OperationResponse, QueryResult,
  WorldCommandEnvelope, WorldQuery, WorldRef,
} from '@/types/world';

type Outer<T> = { success: true; data: T } | { success: false; error: Failure };
export type PrivateDelivery<T> =
  | { outcome: 'response'; response: { status: number; body: Outer<T> } }
  | { outcome: 'not-attempted' | 'unknown'; reason?: string };
export type StorageStatus =
  | { outcome: 'available'; configured: boolean; initialStorageId?: string; targetStorageIds: string[]; registeredTargetStorageIds: string[] }
  | { outcome: 'unavailable'; reason: 'storage-unavailable' };
export type StorageInput =
  | { kind: 'initial' | 'target'; connectionString: string }
  | { kind: 'credentials'; storageId: string; connectionString: string };
export type StorageResult =
  | { outcome: 'saved'; storageId: string; restartRequired: true }
  | { outcome: 'not-saved'; reason: 'invalid-request' | 'already-configured' | 'unauthorized' }
  | { outcome: 'unknown'; reason: 'storage-unavailable' };
export type SourceCredential =
  | { kind: 'none' }
  | { kind: 'http_bearer'; token: string }
  | { kind: 'postgres'; user: string; password: string };
export type StorageTransferInput =
  | { action: 'prepare'; world: WorldRef; targetStorageId: string }
  | { action: 'resume' | 'abort' | 'status'; transferId: string }
  | { action: 'status'; world: WorldRef };
export type StorageTransferStatus = {
  transferId: string; world: WorldRef; targetStorageId: string;
  phase: 'unknown' | 'prepared' | 'activated' | 'aborted' | 'failed';
  action: 'resume' | 'abort'; error?: Failure;
};
export type StorageTransferResult =
  | { outcome: 'status'; transfer: StorageTransferStatus }
  | { outcome: 'not-found' }
  | { outcome: 'not-attempted'; reason: 'invalid-request' | 'transfer-conflict' | 'restart-required' | 'unauthorized' }
  | { outcome: 'unknown'; reason: 'storage-unavailable'; transferId?: string };

export class WorldRequestError extends Error {
  constructor(readonly failure: Failure) { super(failure.message); }
}
export class WorldDeliveryUnknown extends Error {
  constructor() { super(i18n.t('world:client.deliveryUnknown')); }
}
function unwrap<T>(body: Outer<T>): T {
  if (!body || typeof body !== 'object' || typeof body.success !== 'boolean') {
    throw new Error(i18n.t('world:client.unrecognizedResponse'));
  }
  if (body.success) return body.data;
  if (body.error?.code === 'world.delivery_unknown') throw new WorldDeliveryUnknown();
  throw new WorldRequestError(body.error);
}
async function post<T>(route: 'query' | 'command' | 'operation', request: unknown): Promise<T> {
  let body: Outer<T>;
  try {
    body = await hostApiFetchWithFailure<Outer<T>>(`/api/world/${route}`, {
      method: 'POST', body: JSON.stringify(request),
    }, (_status, failure) => failure && typeof failure === 'object' && 'success' in failure
      && failure.success === false ? failure as Outer<T> : null);
  } catch (error) {
    // Losing the observer is not evidence that a mutation rolled back.
    if (route !== 'query') throw new WorldDeliveryUnknown();
    throw error;
  }
  return unwrap(body);
}
type QueryResults = { [R in QueryResult as R['kind']]: R['result'] };
export async function queryWorld<K extends keyof QueryResults>(
  world: WorldRef, query: WorldQuery, kind: K,
): Promise<QueryResults[K]> {
  const response = await post<QueryResult>('query', { world, query });
  if (response.kind !== kind) throw new Error(i18n.t('world:client.queryResultMismatch'));
  return response.result as QueryResults[K];
}
export function commandWorld(request: WorldCommandEnvelope): Promise<CommandResult> {
  return post('command', request);
}
export function operationWorld(request: OperationRequest): Promise<OperationResponse> {
  return post('operation', request);
}
export async function configureSource(request: WorldCommandEnvelope, credential?: SourceCredential): Promise<CommandResult> {
  let result: PrivateDelivery<CommandResult>;
  try { result = await invokeIpc('world:configureConnection', { request, ...(credential ? { credential } : {}) }); }
  catch { throw new WorldDeliveryUnknown(); }
  if (result.outcome === 'response') return unwrap(result.response.body);
  if (result.outcome === 'unknown') throw new WorldDeliveryUnknown();
  throw new Error(i18n.t(result.reason === 'authorization-denied' ? 'world:client.authorizationDenied'
    : result.reason === 'authorization-unavailable' ? 'world:client.authorizationUnavailable' : 'world:client.connectionNotSent'));
}
export const storageStatus = (): Promise<StorageStatus> => invokeIpc('world:storageStatus');
export const configureStorage = (input: StorageInput): Promise<StorageResult> => invokeIpc('world:configureStorage', input);
export async function openStorage(input?: StorageOpenInput): Promise<StorageOpenResult> {
  try {
    return await (input ? invokeIpc<StorageOpenResult>('world:openStorage', input)
      : invokeIpc<StorageOpenResult>('world:openStorage'));
  } catch {
    return { outcome: 'unknown', error: {
      source: 'renderer', reason: 'response-unconfirmed', code: 'world.storage.response_unconfirmed',
      stage: 'read', diagnosticId: crypto.randomUUID(), recovery: { kind: 'none' },
      details: { kind: 'transport', failure: 'disconnected' },
    } };
  }
}
export const prepareWorldAccess = (intent: WorldAccessIntent): Promise<WorldAccessPrepareResult> => invokeIpc('world:prepareAccess', intent);
export const commitWorldAccess = (intent: WorldAccessCommitIntent): Promise<WorldAccessImportResult> => invokeIpc('world:commitAccess', intent);
export const prepareWorldEvaluation = (intent: WorldEvaluationIntent): Promise<WorldEvaluationPrepareResult> => invokeIpc('world:prepareEvaluation', intent);
export const commitWorldEvaluation = (intent: WorldEvaluationCommitIntent): Promise<WorldEvaluationCommitResult> => invokeIpc('world:commitEvaluation', intent);
export const worldEvaluationStatus = (intent: WorldEvaluationIntent): Promise<WorldEvaluationStatusResult> => invokeIpc('world:evaluationStatus', intent);
export const transferStorage = (input: StorageTransferInput): Promise<StorageTransferResult> => invokeIpc('world:transferStorage', input);
export async function digestBytes(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')}`;
}
export async function digestFile(file: File): Promise<string> {
  const hash = sha256.create();
  try {
    for (let offset = 0; offset < file.size; offset += 131_072) {
      const bytes = await file.slice(offset, offset + 131_072).arrayBuffer();
      hash.update(new Uint8Array(bytes));
    }
    return `sha256:${Array.from(hash.digest(), value => value.toString(16).padStart(2, '0')).join('')}`;
  } finally { hash.destroy(); }
}
export function sameWorld(left: WorldRef, right: WorldRef): boolean {
  return left.tenantId === right.tenantId && left.worldId === right.worldId;
}
