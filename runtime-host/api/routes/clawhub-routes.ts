import { ClawHubService, listInstalledClawHubSkills } from '../../application/skills/clawhub';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function handleClawHubRouteLocal(method, routePath, payload) {
  const service = new ClawHubService();

  if (method === 'POST' && routePath === '/api/clawhub/search') {
    const body = isRecord(payload) ? payload : {};
    return {
      status: 200,
      data: {
        success: true,
        results: await service.search(body),
      },
    };
  }

  if (method === 'POST' && routePath === '/api/clawhub/auth/login') {
    return {
      status: 200,
      data: await service.login(),
    };
  }

  if (method === 'POST' && routePath === '/api/clawhub/install') {
    const body = isRecord(payload) ? payload : {};
    return {
      status: 200,
      data: await service.install(body),
    };
  }

  if (method === 'POST' && routePath === '/api/clawhub/uninstall') {
    const body = isRecord(payload) ? payload : {};
    return {
      status: 200,
      data: await service.uninstall(body),
    };
  }

  if (method === 'GET' && routePath === '/api/clawhub/list') {
    return {
      status: 200,
      data: {
        success: true,
        results: await service.list(),
      },
    };
  }

  if (method === 'POST' && routePath === '/api/clawhub/open-readme') {
    const body = isRecord(payload) ? payload : {};
    const skillKeyOrSlug = typeof body.skillKey === 'string'
      ? body.skillKey
      : (typeof body.slug === 'string' ? body.slug : '');
    return {
      status: 200,
      data: await service.openReadme(skillKeyOrSlug, typeof body.slug === 'string' ? body.slug : undefined),
    };
  }

  return null;
}

export { handleClawHubRouteLocal as handleClawHubRoute, listInstalledClawHubSkills };
