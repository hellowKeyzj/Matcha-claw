import { hostApiFetchWithFailure } from '@/lib/host-api';
import { AppError } from '@/lib/error-model';
import type { AccessCommand, AccessErrorCode, AccessSnapshot } from '@/types/resource-access';
import type { NetworkErrorCode, NetworkRequest, NetworkSnapshot } from '@/types/desktop/network-access';
import type { CapabilityCall, CapabilityCallReceipt, ConnectionPreview, InterconnectCommand, InterconnectSnapshot, RemoteCapability } from '@/types/desktop/interconnect';

export type AccessUiError = AccessErrorCode | NetworkErrorCode | 'request-failed' | 'response-too-large' | 'busy' | 'invitation-expired';
const ERROR_CODES: readonly AccessUiError[] = ['invalid-request', 'unauthorized', 'forbidden', 'not-found', 'conflict', 'unavailable', 'outcome-unknown', 'network-change-required', 'component-missing', 'start-failed', 'stop-failed', 'storage-unavailable', 'security-blocked', 'busy', 'invitation-expired'];

export function failureCode(error: string): AccessUiError {
  return ERROR_CODES.find((code) => code === error) ?? (error === 'response-too-large' ? error : 'request-failed');
}

export class AccessRequestError extends Error {
  constructor(readonly code: AccessUiError) { super(code); }
}

export function accessError(error: unknown, mutation = false): AccessUiError {
  if (error instanceof AccessRequestError) return error.code;
  if (error instanceof AppError) {
    if (error.details?.status === 409) return 'conflict';
    if (error.details?.status === 401) return 'unauthorized';
    if (error.details?.status === 403) return 'forbidden';
    if (error.details?.status === 400) return 'invalid-request';
    if (error.details?.status === 404) return 'not-found';
  }
  return mutation ? 'outcome-unknown' : 'unavailable';
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const result = await hostApiFetchWithFailure<T | AccessRequestError>(
    path,
    body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) },
    (_status, failure) => {
      if (!failure || typeof failure !== 'object' || !('success' in failure) || failure.success !== false || !('error' in failure)) return null;
      const code = ERROR_CODES.find((code) => code === failure.error);
      return code ? new AccessRequestError(code) : null;
    },
  );
  // Throw after Host API normalization so the domain error keeps its typed code.
  if (result instanceof AccessRequestError) throw result;
  return result;
}

export function readAccess(): Promise<AccessSnapshot> { return request('/api/access'); }
export function commandAccess(command: AccessCommand): Promise<AccessSnapshot> { return request('/api/access/command', command); }
export function readNetwork(): Promise<NetworkSnapshot> { return request('/api/access-network'); }
export function commandNetwork(command: NetworkRequest): Promise<NetworkSnapshot> { return request('/api/access-network/command', command); }

async function interconnectRequest<T>(path: string, body?: unknown): Promise<T> {
  const result = await hostApiFetchWithFailure<T | AccessRequestError>(path,
    body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) },
    (status, failure) => {
      if (!failure || typeof failure !== 'object' || !('success' in failure) || failure.success !== false || !('error' in failure)) return null;
      const mapped = typeof failure.error === 'string' ? failureCode(failure.error) : 'request-failed';
      const code = mapped !== 'request-failed' ? mapped
        : ({ 400: 'invalid-request', 401: 'unauthorized', 403: 'forbidden', 404: 'not-found', 409: 'conflict' } as const)[status as 400 | 401 | 403 | 404 | 409] ?? mapped;
      return new AccessRequestError(code);
    });
  if (result instanceof AccessRequestError) throw result;
  return result;
}

export function readInterconnect(): Promise<InterconnectSnapshot> { return interconnectRequest('/api/interconnect'); }
export function refreshClients(): Promise<InterconnectSnapshot> { return interconnectRequest('/api/interconnect/command', { kind: 'clients.refresh' } satisfies InterconnectCommand); }
export function inviteClient(name: string, maxUses: number, hostName: string, expectedRevision: number): Promise<{ invitation: string }> { return interconnectRequest('/api/interconnect/command', { kind: 'invite', name, maxUses, hostName, expectedRevision } satisfies InterconnectCommand); }
export function stopInvitation(invitationId: string): Promise<InterconnectSnapshot> { return interconnectRequest('/api/interconnect/command', { kind: 'invitation.revoke', invitationId } satisfies InterconnectCommand); }
export function previewConnection(invitation: string): Promise<ConnectionPreview> { return interconnectRequest('/api/interconnect/command', { kind: 'connect.preview', invitation } satisfies InterconnectCommand); }
export function connectClient(command: Omit<Extract<InterconnectCommand, { kind: 'connect' }>, 'kind'>): Promise<InterconnectSnapshot> { return interconnectRequest('/api/interconnect/command', { kind: 'connect', ...command } satisfies InterconnectCommand); }
export function disconnectClient(clientId: string): Promise<InterconnectSnapshot> { return interconnectRequest('/api/interconnect/command', { kind: 'disconnect', clientId }); }
export function shareCapability(sourceId: string, expectedRevision: number): Promise<AccessSnapshot> {
  return interconnectRequest('/api/interconnect/command', { kind: 'share', sourceId, expectedRevision } satisfies InterconnectCommand);
}
export function shareFolder(command: Omit<Extract<InterconnectCommand, { kind: 'share.folder' }>, 'kind'>): Promise<AccessSnapshot> {
  return interconnectRequest('/api/interconnect/command', { kind: 'share.folder', ...command } satisfies InterconnectCommand);
}
export function discoverCapabilities(clientId: string): Promise<{ capabilities: RemoteCapability[] }> { return interconnectRequest('/api/interconnect/discover', { clientId }); }
export function invokeCapability(call: CapabilityCall): Promise<CapabilityCallReceipt> { return interconnectRequest('/api/interconnect/invoke', call); }
export function readCapabilityResult(clientId: string, callId: string): Promise<CapabilityCallReceipt> { return interconnectRequest('/api/interconnect/result', { clientId, callId }); }
