import { hostApiFetch } from '@/lib/host-api';
import type { SearchConfig, SearchSnapshot, SearchVerification, SearchVerifyRequest } from '@/types/network-search';

// Includes Python preparation and dependency installation, not just the service start.
const SEARCH_OPERATION_TIMEOUT_MS = 900_000;

export function fetchNetworkSearch(signal?: AbortSignal): Promise<SearchSnapshot> {
  return hostApiFetch('/api/search', { signal });
}

export function saveNetworkSearch(expectedRevision: number, config: SearchConfig, signal: AbortSignal): Promise<SearchSnapshot> {
  return hostApiFetch('/api/search/config', {
    method: 'PUT', body: JSON.stringify({ expectedRevision, config }), signal,
    timeoutMs: SEARCH_OPERATION_TIMEOUT_MS,
  });
}

export function runNetworkSearchService(action: 'prepare' | 'restart' | 'stop', signal: AbortSignal): Promise<SearchSnapshot> {
  return hostApiFetch(`/api/search/${action}`, {
    method: 'POST', signal, timeoutMs: action === 'stop' ? 90_000 : SEARCH_OPERATION_TIMEOUT_MS,
  });
}

export function verifyNetworkSearch(request: SearchVerifyRequest, signal: AbortSignal): Promise<SearchVerification> {
  return hostApiFetch('/api/search/verify', {
    method: 'POST', body: JSON.stringify(request), signal, timeoutMs: 180_000,
  });
}

export function fetchNetworkSearchLogs(signal: AbortSignal): Promise<{ lines: string[] }> {
  return hostApiFetch('/api/search/logs', { signal });
}
