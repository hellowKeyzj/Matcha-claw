import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type {
  SecurityOperationRequest,
  SecurityPolicyTransport,
} from '../../main/runtime-host-delivery/transport/security/policy';
import { isSecurityOperationId, isSecurityOperationRequest } from '../../main/runtime-host-delivery/transport/security/policy';
import type { SecurityRuleCatalogTransport } from '../../main/runtime-host-delivery/transport/security/rule-catalog';
import {
  logSessionTrace,
  readTraceHeader,
} from '../../main/runtime-host-delivery/transport/sessions/trace';

const OPERATION_INVALID = {
  success: false,
  error: 'Security operation request is invalid',
} as const;
const OPERATION_UNAVAILABLE = {
  success: false,
  error: 'Security operation is unavailable',
} as const;

const POLICY_UNAVAILABLE = {
  success: false,
  error: 'Security policy is unavailable',
} as const;
const AUDIT_INVALID = {
  success: false,
  error: 'Security audit request is invalid',
} as const;
const AUDIT_UNAVAILABLE = {
  success: false,
  error: 'Security audit is unavailable',
} as const;
const CATALOG_UNAVAILABLE = {
  success: false,
  error: 'Security rule catalog is unavailable',
} as const;

const DEFAULT_AUDIT_PAGE = 1;
const DEFAULT_AUDIT_PAGE_SIZE = 20;
const MAX_AUDIT_PAGE = 10_000;
const MAX_AUDIT_PAGE_SIZE = 200;

export async function handleSecurityRoutes(
  req: HostApiRequest,
  url: URL,
  transport: SecurityPolicyTransport,
  catalogTransport: SecurityRuleCatalogTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/security/operation/receipt' && req.method === 'POST') {
    let body: unknown;
    try { body = await req.readJson(); } catch {
      return jsonResult(400, OPERATION_INVALID);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResult(400, OPERATION_INVALID);
    }
    const request = body as Record<string, unknown>;
    if (Object.keys(request).length !== 2 || typeof request.correlation !== 'string'
      || !isSecurityOperationId(request.operationId)) {
      return jsonResult(400, OPERATION_INVALID);
    }
    try {
      const response = await transport.operationReceipt(request.correlation, request.operationId);
      return jsonResult(response.status, response.body);
    } catch { return jsonResult(503, OPERATION_UNAVAILABLE); }
  }
  if (url.pathname === '/api/security/operation' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await req.readJson();
    } catch {
      return jsonResult(400, OPERATION_INVALID);
    }
    if (!isSecurityOperationRequest(body)) {
      return jsonResult(400, OPERATION_INVALID);
    }
    try {
      const response = await transport.operate(body as SecurityOperationRequest);
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, OPERATION_UNAVAILABLE);
    }
  }

  if (req.method !== 'GET') return undefined;

  if (url.pathname === '/api/security') {
    const traceId = readTraceHeader(req.headers);
    logSessionTrace('electron.security.policy.request', traceId, () => ({
      method: req.method,
      path: url.pathname,
    }));
    try {
      const policy = await transport.read(traceId);
      logSessionTrace('electron.security.policy.response', traceId, () => ({
        status: policy ? 200 : 503,
        contract: policy ? 'policy' : 'unavailable',
      }));
      return jsonResult(policy ? 200 : 503, policy ?? POLICY_UNAVAILABLE);
    } catch {
      logSessionTrace('electron.security.policy.failure', traceId);
      return jsonResult(503, POLICY_UNAVAILABLE);
    }
  }

  if (url.pathname === '/api/security/audit') {
    const query = parseAuditQuery(url);
    if (!query) {
      return jsonResult(400, AUDIT_INVALID);
    }
    try {
      const audit = await transport.readAudit(query.page, query.pageSize);
      return jsonResult(audit ? 200 : 503, audit ?? AUDIT_UNAVAILABLE);
    } catch {
      return jsonResult(503, AUDIT_UNAVAILABLE);
    }
  }

  if (url.pathname === '/api/security/destructive-rule-catalog') {
    try {
      const catalog = await catalogTransport.read(url.searchParams.get('platform'));
      return jsonResult(catalog.status, catalog.body);
    } catch {
      return jsonResult(503, CATALOG_UNAVAILABLE);
    }
  }

  return undefined;
}

function parseAuditQuery(url: URL): { page: number; pageSize: number } | null {
  let page = DEFAULT_AUDIT_PAGE;
  let pageSize = DEFAULT_AUDIT_PAGE_SIZE;
  const seen = new Set<string>();

  for (const [name, value] of url.searchParams.entries()) {
    if (name !== 'page' && name !== 'pageSize') return null;
    if (seen.has(name)) return null;
    seen.add(name);
    const parsed = parsePositiveInteger(value);
    if (parsed === null) return null;
    if (name === 'page') {
      if (parsed > MAX_AUDIT_PAGE) return null;
      page = parsed;
    } else {
      if (parsed > MAX_AUDIT_PAGE_SIZE) return null;
      pageSize = parsed;
    }
  }

  return { page, pageSize };
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
