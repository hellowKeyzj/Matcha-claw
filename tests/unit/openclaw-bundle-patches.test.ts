import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOpenClawBundlePatches } from '../../scripts/openclaw-bundle-patches.mjs';

const tempRoots: string[] = [];

function createTempOpenClawPackage(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matcha-openclaw-patches-'));
  tempRoots.push(root);
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });

  fs.writeFileSync(path.join(dist, 'providers.runtime-test.js'), [
    'function resolveProviderConfigApiOwnerHint(params) {',
    '\tconst normalizedProvider = normalizeProviderId(params.provider);',
    '\tif (!normalizedProvider) return;',
    '\tconst api = typeof providerConfig?.api === "string" ? normalizeProviderId(providerConfig.api) : "";',
    '\treturn api;',
    '}',
  ].join('\n'));

  fs.writeFileSync(path.join(dist, 'model-auth-test.js'), [
    'function shouldDeferSyntheticProfileAuth(params) {',
    '\tconst providerConfig = resolveProviderConfig(params.cfg, params.provider);',
    '\tshouldDeferProviderSyntheticProfileAuthWithPlugin({',
    '\t\tresolvedApiKey: params.resolvedApiKey',
    '\t});',
    '}',
  ].join('\n'));

  fs.writeFileSync(path.join(dist, 'protocol-test.js'), [
    'const WebLoginStartParamsSchema = Type.Object({',
    '\tforce: Type.Optional(Type.Boolean()),',
    '\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),',
    '\tverbose: Type.Optional(Type.Boolean()),',
    '\taccountId: Type.Optional(Type.String())',
    '}, { additionalProperties: false });',
    'const QrDataUrlSchema = Type.String({',
    '\tmaxLength: 16384,',
    '\tpattern: "^data:image/png;base64,"',
    '});',
    'const WebLoginWaitParamsSchema = Type.Object({',
    '\ttimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),',
    '\taccountId: Type.Optional(Type.String()),',
    '\tcurrentQrDataUrl: Type.Optional(QrDataUrlSchema)',
    '}, { additionalProperties: false });',
  ].join('\n'));

  fs.writeFileSync(path.join(dist, 'server-methods-test.js'), [
    'const WEB_LOGIN_METHODS = new Set(["web.login.start", "web.login.wait"]);',
    'const resolveWebLoginProvider = () => listChannelPlugins().find((plugin) => [...plugin.gatewayMethods ?? [], ...(plugin.gatewayMethodDescriptors ?? []).map((descriptor) => descriptor.name)].some((method) => WEB_LOGIN_METHODS.has(method))) ?? null;',
    'const webHandlers = {',
    '\t"web.login.start": async ({ params }) => {',
    '\t\tconst provider = resolveWebLoginProvider();',
    '\t\tconst result = await provider.gateway.loginWithQrStart({',
    '\t\t\tforce: Boolean(params.force),',
    '\t\t\ttimeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : void 0,',
    '\t\t\tverbose: Boolean(params.verbose),',
    '\t\t\taccountId: typeof params.accountId === "string" ? params.accountId : void 0',
    '\t\t});',
    '\t},',
    '\t"web.login.wait": async ({ params }) => {',
    '\t\tconst provider = resolveWebLoginProvider();',
    '\t\tconst result = await provider.gateway.loginWithQrWait({',
    '\t\t\t\ttimeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : void 0,',
    '\t\t\t\taccountId,',
    '\t\t\t\tcurrentQrDataUrl: typeof params.currentQrDataUrl === "string" ? params.currentQrDataUrl : void 0',
    '\t\t\t});',
    '\t}',
    '};',
  ].join('\n'));

  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('openclaw bundle patches', () => {
  it('patches the shared web login contract and retains custom provider patches', () => {
    const openclawDir = createTempOpenClawPackage();

    const results = applyOpenClawBundlePatches(openclawDir, { log: () => undefined });

    expect(results).toContainEqual(expect.objectContaining({
      id: 'custom-provider-skip-api-owner-hint',
      status: 'applied',
    }));
    expect(results).toContainEqual(expect.objectContaining({
      id: 'custom-provider-skip-synthetic-profile-defer',
      status: 'applied',
    }));
    expect(results).toContainEqual(expect.objectContaining({
      id: 'openclaw-web-login-contract',
      status: 'applied',
    }));
    expect(fs.readFileSync(path.join(openclawDir, 'dist', 'providers.runtime-test.js'), 'utf8'))
      .toContain('if (!normalizedProvider || normalizedProvider.startsWith("custom-")) return;');
    expect(fs.readFileSync(path.join(openclawDir, 'dist', 'model-auth-test.js'), 'utf8'))
      .toContain('if (normalizeProviderId(params.provider).startsWith("custom-")) return false;');
    expect(fs.readFileSync(path.join(openclawDir, 'dist', 'protocol-test.js'), 'utf8'))
      .toContain('channel: Type.Optional(NonEmptyString),');
    expect(fs.readFileSync(path.join(openclawDir, 'dist', 'protocol-test.js'), 'utf8'))
      .toContain('sessionKey: Type.Optional(NonEmptyString),');
    expect(fs.readFileSync(path.join(openclawDir, 'dist', 'server-methods-test.js'), 'utf8'))
      .toContain('resolveWebLoginProvider(params.channel)');
    expect(fs.readFileSync(path.join(openclawDir, 'dist', 'server-methods-test.js'), 'utf8'))
      .toContain('sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : void 0,');
  });

  it('keeps the web login bundle patch idempotent', () => {
    const openclawDir = createTempOpenClawPackage();
    applyOpenClawBundlePatches(openclawDir, { log: () => undefined });

    const results = applyOpenClawBundlePatches(openclawDir, { log: () => undefined });

    expect(results).toContainEqual(expect.objectContaining({
      id: 'openclaw-web-login-contract',
      status: 'clean',
    }));
  });
});
