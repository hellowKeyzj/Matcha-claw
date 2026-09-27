import type { IncomingMessage, ServerResponse } from 'http';
import { dialog } from 'electron';
import type { SealedSkillsTransport } from '../../main/runtime-host-delivery/transport/skills/sealed';
import type { SkillsManagementTransport } from '../../main/runtime-host-delivery/transport/skills/management';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = { outcome: 'rejected' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

type SealedSkillsRouteOperation = Exclude<keyof SealedSkillsTransport, 'readStatus'> | 'status' | 'installLocal';

export async function handleSealedSkillsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: SealedSkillsTransport,
  _skillsManagementTransport: SkillsManagementTransport,
): Promise<boolean> {
  const operation = routeOperation(url.pathname, req.method);
  if (!operation) return false;

  if (operation === 'status') {
    try {
      const response = await transport.readStatus();
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNKNOWN);
    }
    return true;
  }

  if (operation === 'installLocal') {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Matcha sealed skill package', extensions: ['matcha-skillpkg'] }],
      });
      const packagePath = result.filePaths[0];
      if (result.canceled || !packagePath) {
        sendJson(res, 200, { outcome: 'canceled' });
        return true;
      }
      const response = await transport.install({ packagePath });
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNKNOWN);
    }
    return true;
  }

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    if (operation === 'export') {
      console.info('[startup-trace]', {
        source: 'sealed-skills-export',
        phase: 'route',
        detail: 'invalid-json',
      });
    }
    sendJson(res, 400, INVALID);
    return true;
  }
  const exportSkillKey = operation === 'export' ? skillKeyFromBody(body) : null;
  if (operation === 'export') {
    console.info('[startup-trace]', {
      source: 'sealed-skills-export',
      phase: 'route',
      detail: exportSkillKey ? 'request' : 'invalid-request',
      ...(exportSkillKey ? { skillKey: exportSkillKey } : {}),
    });
  }

  try {
    const response = await transport[operation](body);
    if (operation === 'export') {
      console.info('[startup-trace]', {
        source: 'sealed-skills-export',
        phase: 'route',
        detail: 'response',
        status: response.status,
        outcome: outcomeFromBody(response.body),
        ...(exportSkillKey ? { skillKey: exportSkillKey } : {}),
      });
    }
    sendJson(res, response.status, response.body);
  } catch {
    if (operation === 'export') {
      console.info('[startup-trace]', {
        source: 'sealed-skills-export',
        phase: 'route',
        detail: 'exception',
        ...(exportSkillKey ? { skillKey: exportSkillKey } : {}),
      });
    }
    sendJson(res, 503, UNKNOWN);
  }
  return true;
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
