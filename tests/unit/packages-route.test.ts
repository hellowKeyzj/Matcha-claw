import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { handlePackageRoutes } from '../../electron/api/routes/packages';

function incoming(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

describe('packages host API route', () => {
  it('installs downloaded agent packages through subagent package install', async () => {
    const cloudAccountService = {
      downloadPackage: vi.fn().mockResolvedValue({
        packagePath: 'C:/sealed/writer.matcha-agentpkg',
        packageVersionId: 'version-writer',
        filename: 'writer.matcha-agentpkg',
        bytes: 1024,
      }),
    };
    const agentsTransport = {
      execute: vi.fn().mockResolvedValue({
        status: 200,
        body: { success: true, package: { agentId: 'writer' } },
      }),
    };
    const sealedSkillsTransport = { install: vi.fn() };
    const result = response();

    await expect(handlePackageRoutes(
      incoming({ packageVersionId: 'version-writer', packageType: 'agent', source: 'subagents' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/packages/install'),
      { cloudAccountService, runtimeHostTransports: { agentsTransport, sealedSkillsTransport } } as never,
    )).resolves.toBe(true);

    expect(cloudAccountService.downloadPackage).toHaveBeenCalledWith({
      packageVersionId: 'version-writer',
      packageType: 'agent',
      source: 'subagents',
    });
    expect(agentsTransport.execute).toHaveBeenCalledWith({
      id: 'subagent.management',
      operationId: 'subagents.package.install',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'subagent' },
      input: { kind: 'packageInstall', endpoint, packagePath: 'C:/sealed/writer.matcha-agentpkg' },
    });
    expect(sealedSkillsTransport.install).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        packagePath: 'C:/sealed/writer.matcha-agentpkg',
        packageVersionId: 'version-writer',
        filename: 'writer.matcha-agentpkg',
        bytes: 1024,
        install: { outcome: 'accepted', agentId: 'writer' },
      },
    });
  });
});
