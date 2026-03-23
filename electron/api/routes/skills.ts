import type { IncomingMessage, ServerResponse } from 'http';
import { getAllSkillConfigs, updateSkillConfig } from '../../utils/skill-config';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleSkillRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/skills/configs' && req.method === 'GET') {
    sendJson(res, 200, await getAllSkillConfigs());
    return true;
  }

  if (url.pathname === '/api/skills/effective' && req.method === 'GET') {
    if (!ctx.platformFacade) {
      sendJson(res, 501, { success: false, error: 'platform facade unavailable' });
      return true;
    }
    try {
      const tools = await ctx.platformFacade.listEffectiveTools({
        includeDisabled: false,
      });
      sendJson(res, 200, { success: true, tools });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/skills/config' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{
        skillKey: string;
        apiKey?: string;
        env?: Record<string, string>;
      }>(req);
      sendJson(res, 200, await updateSkillConfig(body.skillKey, {
        apiKey: body.apiKey,
        env: body.env,
      }));
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/search' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      sendJson(res, 200, {
        success: true,
        results: await ctx.clawHubService.search(body),
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/auth/login' && req.method === 'POST') {
    try {
      await ctx.clawHubService.loginAndSyncToken();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/install' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      await ctx.clawHubService.install(body);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/uninstall' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      await ctx.clawHubService.uninstall(body);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/list' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, results: await ctx.clawHubService.listInstalled() });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/open-readme' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ slug?: string; skillKey?: string }>(req);
      await ctx.clawHubService.openSkillReadme(body.skillKey || body.slug || '', body.slug);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
