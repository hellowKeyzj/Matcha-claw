import { traceDebug, isTraceEnabled } from '../../utils/trace-logger';
import { dialog } from 'electron';
import type { SealedSkillsTransport } from '../../main/runtime-host-delivery/transport/skills/sealed';
import { isSkillsRuntimeScope, type SkillsManagementTransport } from '../../main/runtime-host-delivery/transport/skills/management';
import { readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';
import { hasExactKeys, isRecord } from '../../main/runtime-host-delivery/transport/client';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = { outcome: 'rejected' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

type SealedSkillsRouteOperation = 'export' | 'install' | 'uninstall' | 'status' | 'installLocal';

export async function handleSealedSkillsRoutes(
  req: HostApiRequest,
  url: URL,
  transport: SealedSkillsTransport,
  _skillsManagementTransport: SkillsManagementTransport,
): Promise<HostApiRouteResult> {
  const operation = routeOperation(url.pathname, req.method);
  if (!operation) return undefined;

  if (operation === 'status') {
    try {
      const response = await transport.readStatus(readRuntimeScopeQuery(url.searchParams));
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNKNOWN);
    }
  }

  if (operation === 'installLocal') {
    let request: unknown;
    try { request = await req.readJson(); } catch {
      return jsonResult(400, INVALID);
    }
    if (!isRecord(request) || !(hasExactKeys(request, [])
      || (hasExactKeys(request, ['scope']) && isSkillsRuntimeScope(request.scope)))) {
      return jsonResult(400, INVALID);
    }
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Matcha sealed skill package', extensions: ['matcha-skillpkg'] }],
      });
      const packagePath = result.filePaths[0];
      if (result.canceled || !packagePath) {
        return jsonResult(200, { outcome: 'canceled' });
      }
      const response = await transport.install({ packagePath, ...(Object.hasOwn(request, 'scope') ? { scope: request.scope } : {}) });
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNKNOWN);
    }
  }

  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    if (operation === 'export') {
      traceDebug(() => ['[startup-trace]', {
        source: 'sealed-skills-export',
        phase: 'route',
        detail: 'invalid-json',
      }]);
    }
    return jsonResult(400, INVALID);
  }
  const exportSkillKey = operation === 'export' && isTraceEnabled() ? skillKeyFromBody(body) : null;
  if (operation === 'export') {
    traceDebug(() => ['[startup-trace]', {
      source: 'sealed-skills-export',
      phase: 'route',
      detail: exportSkillKey ? 'request' : 'invalid-request',
      ...(exportSkillKey ? { skillKey: exportSkillKey } : {}),
    }]);
  }

  try {
    const response = await transport[operation](body);
    if (operation === 'export') {
      traceDebug(() => ['[startup-trace]', {
        source: 'sealed-skills-export',
        phase: 'route',
        detail: 'response',
        status: response.status,
        outcome: outcomeFromBody(response.body),
        ...(exportSkillKey ? { skillKey: exportSkillKey } : {}),
      }]);
    }
    return jsonResult(response.status, response.body);
  } catch {
    if (operation === 'export') {
      traceDebug(() => ['[startup-trace]', {
        source: 'sealed-skills-export',
        phase: 'route',
        detail: 'exception',
        ...(exportSkillKey ? { skillKey: exportSkillKey } : {}),
      }]);
    }
    return jsonResult(503, UNKNOWN);
  }
}

function routeOperation(pathname: string, method: string | undefined): SealedSkillsRouteOperation | undefined {
  if (method === 'GET' && pathname === '/api/sealed-skills/status') return 'status';
  if (method !== 'POST') return undefined;
  switch (pathname) {
    case '/api/sealed-skills/export': return 'export';
    case '/api/sealed-skills/install': return 'install';
    case '/api/sealed-skills/install-local': return 'installLocal';
    case '/api/sealed-skills/uninstall': return 'uninstall';
    default: return undefined;
  }
}

function skillKeyFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('skillKey' in body)) return null;
  const value = (body as { skillKey?: unknown }).skillKey;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function outcomeFromBody(body: unknown): string {
  if (!body || typeof body !== 'object' || !('outcome' in body)) return 'unknown';
  const value = (body as { outcome?: unknown }).outcome;
  return typeof value === 'string' ? value : 'unknown';
}
