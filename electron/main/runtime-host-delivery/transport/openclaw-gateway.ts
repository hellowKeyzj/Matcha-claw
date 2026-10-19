import {
  decodeOpenClawQuestionListResult,
  decodeOpenClawQuestionResolveResult,
  isOpenClawQuestionListInput,
  isOpenClawQuestionResolveInput,
} from '../../../../src/types/openclaw-question';
import {
  decodeBrowserMutationResult, decodeBrowserOperationFailure, decodeBrowserScreenshot, decodeBrowserStartResult,
  decodeBrowserStatus, decodeBrowserTab, decodeBrowserTabs, isBrowserRequestInput, type BrowserRequestInput,
} from '../../../../src/types/openclaw-browser';
import {
  decodeOpenClawCanvasViewResult, decodeOpenClawMcpAppResult, decodeOpenClawProgressCardResult, decodeOpenClawSurfaceError,
  isOpenClawCanvasRequest, isOpenClawMcpAppRequest, isOpenClawProgressCardRequest,
  type OpenClawCanvasRequest, type OpenClawMcpAppRequest, type OpenClawProgressCardRequest, type OpenClawSurfaceErrorCode,
} from '../../../../src/types/openclaw-runtime-surface';
import { buildSessionIdentityKey, sessionIdentitiesEqual } from '../../../../src/types/desktop/runtime-address';
import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isRecord, sendLoopbackJsonDelivery, type LoopbackDecision } from './client';

const EXECUTE_PATH = '/api/capabilities/execute';
const INVALID = { success: false, error: 'OpenClaw gateway capability request is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'OpenClaw gateway capability is unavailable' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;
const SURFACE_MESSAGES: Readonly<Record<OpenClawSurfaceErrorCode, string>> = {
  MCP_APP_VIEW_EXPIRED: 'MCP app view has expired; reopen the view',
  SURFACE_INVALID_REQUEST: 'Runtime surface request is invalid',
  SURFACE_UNAVAILABLE: 'Runtime surface is unavailable',
  SURFACE_REJECTED: 'Runtime surface request was rejected',
  SURFACE_INVALID_RESPONSE: 'Runtime surface returned an invalid response',
  SURFACE_CAPACITY_EXHAUSTED: 'Runtime surface capacity is exhausted',
  SURFACE_OUTCOME_UNKNOWN: 'Runtime surface operation outcome is unknown',
};

export type OpenClawGatewayCapabilityResponse = Readonly<{
  status: 200 | 400 | 409 | 503;
  body: unknown;
}>;

type GatewayRequest = Readonly<{ id: string; operationId: string; input: unknown }>;
type SurfaceCapabilityRequest = GatewayRequest & (
  | { id: 'openclaw.mcpApp'; input: OpenClawMcpAppRequest }
  | { id: 'openclaw.canvas'; input: OpenClawCanvasRequest }
  | { id: 'openclaw.progress'; input: OpenClawProgressCardRequest }
);

export interface OpenClawGatewayTransport {
  execute(request: unknown): Promise<OpenClawGatewayCapabilityResponse>;
}

export function isOpenClawSurfaceCapabilityRequest(value: unknown): value is SurfaceCapabilityRequest {
  return isRecord(value) && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && isOpenClawLocalScope(value.scope) && value.target === null
    && ((value.id === 'openclaw.mcpApp' && isOpenClawMcpAppRequest(value.input))
      || (value.id === 'openclaw.canvas' && isOpenClawCanvasRequest(value.input))
      || (value.id === 'openclaw.progress' && isOpenClawProgressCardRequest(value.input)))
    && value.operationId === value.input.operationId;
}

export function createOpenClawGatewayTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): OpenClawGatewayTransport {
  return {
    async execute(request): Promise<OpenClawGatewayCapabilityResponse> {
      const decision = decisionFor(request);
      if (!decision) return { status: 400, body: INVALID };
      const input = request as GatewayRequest;
      const surface = isOpenClawSurfaceCapabilityRequest(input) ? input : null;
      const mutating = surface
        ? input.operationId === 'mcp.app.callTool' || input.operationId === 'mcp.app.updateModelContext'
        : input.operationId === 'question.resolve'
          || (input.id === 'openclaw.browser' && isBrowserRequestInput(input.input) && input.input.method !== 'GET');
      const delivery = await sendLoopbackJsonDelivery({
        port: runtimeHostTransportPort,
        path: EXECUTE_PATH,
        issuer,
        decision,
        method: 'POST',
        fetcher,
        body: request,
        timeoutMs: input.id === 'openclaw.browser' && isBrowserRequestInput(input.input)
          ? (input.input.timeoutMs ?? 30_000) + 5_000 : 35_000,
      });
      if (delivery.outcome !== 'response') {
        return { status: 503, body: surface
          ? surfaceFailure(delivery.outcome === 'unknown' && mutating ? 'SURFACE_OUTCOME_UNKNOWN' : 'SURFACE_UNAVAILABLE')
          : delivery.outcome === 'unknown' && mutating ? UNKNOWN : UNAVAILABLE };
      }
      const response = delivery.response;
      if (response.status === 200) {
        const result = decodeResult(input, response.body);
        if (result !== null) return { status: 200, body: result };
        return { status: 503, body: surface
          ? surfaceFailure(mutating ? 'SURFACE_OUTCOME_UNKNOWN' : 'SURFACE_INVALID_RESPONSE')
          : mutating ? UNKNOWN : UNAVAILABLE };
      }
      if (surface) {
        const error = isRecord(response.body) && hasExactKeys(response.body, ['error'])
          ? decodeOpenClawSurfaceError(response.body.error) : null;
        if (error) return { status: response.status === 400 ? 400 : response.status === 409 ? 409 : 503, body: surfaceFailure(error.code) };
        return { status: response.status === 400 ? 400 : response.status === 409 ? 409 : 503,
          body: surfaceFailure(response.status === 400 ? 'SURFACE_INVALID_REQUEST'
            : mutating && response.status !== 401 && response.status !== 403 ? 'SURFACE_OUTCOME_UNKNOWN' : 'SURFACE_UNAVAILABLE') };
      }
      if (response.status === 400) return { status: 400, body: INVALID };
      if (response.status === 409) return { status: 409, body: UNKNOWN };
      return { status: 503, body: mutating && response.status !== 401 && response.status !== 403 ? UNKNOWN : UNAVAILABLE };
    },
  };
}

function decisionFor(value: unknown): LoopbackDecision | null {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || !isOpenClawLocalScope(value.scope) || value.target !== null) return null;
  if (value.id === 'openclaw.browser' && value.operationId === 'browser.request' && isBrowserRequestInput(value.input)) {
    return { endpoint: EXECUTE_PATH, scope: 'openclaw.browser', capability: 'browser.request', subject: 'openclaw-browser' };
  }
  if (isOpenClawSurfaceCapabilityRequest(value)) {
    return { endpoint: EXECUTE_PATH, scope: value.id, capability: value.operationId,
      subject: buildSessionIdentityKey(value.input.sessionIdentity) };
  }
  if (value.id === 'openclaw.question'
    && ((value.operationId === 'question.list' && isOpenClawQuestionListInput(value.input))
      || (value.operationId === 'question.resolve' && isOpenClawQuestionResolveInput(value.input)))) {
    return { endpoint: EXECUTE_PATH, scope: 'openclaw.question', capability: value.operationId, subject: 'openclaw-question' };
  }
  return null;
}

function decodeResult(request: GatewayRequest, value: unknown): unknown | null {
  if (request.id === 'openclaw.browser' && isBrowserRequestInput(request.input)) return decodeBrowserResult(request.input, value);
  if (isOpenClawSurfaceCapabilityRequest(request)) {
    if (request.id === 'openclaw.canvas') {
      const result = decodeOpenClawCanvasViewResult(value);
      return result && result.documentId === request.input.docId
        && sessionIdentitiesEqual(result.sessionIdentity, request.input.sessionIdentity) ? result : null;
    }
    if (request.id === 'openclaw.progress') {
      const result = decodeOpenClawProgressCardResult(value);
      return result && sessionIdentitiesEqual(result.sessionIdentity, request.input.sessionIdentity) ? result : null;
    }
    const result = decodeOpenClawMcpAppResult(request.input.operationId, value);
    if (request.input.operationId === 'mcp.app.view') {
      return result && 'sessionIdentity' in result && result.viewId === request.input.viewId
        && sessionIdentitiesEqual(result.sessionIdentity, request.input.sessionIdentity) ? result : null;
    }
    return result;
  }
  if (request.id === 'openclaw.question') return request.operationId === 'question.list'
    ? decodeOpenClawQuestionListResult(value) : decodeOpenClawQuestionResolveResult(value);
  return null;
}

function decodeBrowserResult(request: BrowserRequestInput, value: unknown): unknown | null {
  const failure = decodeBrowserOperationFailure(value);
  if (failure) return failure;
  if (request.method === 'GET' && request.path === '/') return decodeBrowserStatus(value);
  if (request.method === 'GET' && request.path === '/tabs') {
    const tabs = decodeBrowserTabs(value);
    return tabs ? { tabs, ...(isRecord(value) && typeof value.running === 'boolean' ? { running: value.running } : {}) } : null;
  }
  if (request.path === '/screenshot') return decodeBrowserScreenshot(value);
  if (request.path === '/tabs/open') return decodeBrowserTab(value);
  if (request.path === '/start') return decodeBrowserStartResult(value);
  return decodeBrowserMutationResult(value);
}

function surfaceFailure(code: OpenClawSurfaceErrorCode) {
  return { error: { code, message: SURFACE_MESSAGES[code] } };
}

function isOpenClawLocalScope(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind', 'endpoint']) && value.kind === 'runtime-instance'
    && isRecord(value.endpoint) && hasExactKeys(value.endpoint, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.endpoint.kind === 'native-runtime' && value.endpoint.runtimeAdapterId === 'openclaw'
    && value.endpoint.runtimeInstanceId === 'local';
}
