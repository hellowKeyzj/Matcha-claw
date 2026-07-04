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

  fs.writeFileSync(path.join(dist, 'core-descriptors-test.js'), [
    'const CORE_GATEWAY_METHOD_SPECS = [',
    '\t{',
    '\t\tname: "chat.send",',
    '\t\tscope: "operator.write"',
    '\t},',
    '];',
    'function createCoreGatewayMethodDescriptors(handlers) {',
    '\tthrow new Error(`gateway method handler is missing a descriptor: ${name}`);',
    '}',
  ].join('\n'));

  fs.writeFileSync(path.join(dist, 'pi-bundle-mcp-runtime-test.js'), [
    'function createSessionMcpRuntime(params) {',
    '\tlet catalog = null;',
    '\treturn {',
    '\t\tgetCatalog,',
    '\t};',
    '}',
    'function createSessionMcpRuntimeManager() {',
    '\tconst runtimesBySessionId = new Map();',
    '\tconst sessionIdBySessionKey = new Map();',
    '\treturn {',
    '\t\tresolveSessionId(sessionKey) {',
    '\t\t\treturn sessionIdBySessionKey.get(sessionKey);',
    '\t\t},',
    '\t};',
    '}',
    'function getSessionMcpRuntimeManager() {',
    '\treturn createSessionMcpRuntimeManager();',
    '}',
    'export { getSessionMcpRuntimeManager as g };',
  ].join('\n'));

  fs.writeFileSync(path.join(dist, 'server-methods-test.js'), [
    'import { t as createSubsystemLogger } from "./subsystem-BIvbRvCg.js";',
    'const coreGatewayHandlers = {',
    '\t...chatHandlers,',
    '};',
    'function createRequestGatewayMethodRegistry(extraHandlers) {',
    '\treturn extraHandlers;',
    '}',
  ].join('\n'));

  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('openclaw bundle patches', () => {
  it('patches OpenClaw gateway to expose cached session MCP client status', () => {
    const openclawDir = createTempOpenClawPackage();
    const logs: string[] = [];

    const results = applyOpenClawBundlePatches(openclawDir, { log: (line) => logs.push(line) });

    expect(results).toContainEqual(expect.objectContaining({
      id: 'openclaw-mcp-status-gateway-method',
      status: 'applied',
    }));
    expect(logs.some((line) => line.includes('openclaw-mcp-status-gateway-method'))).toBe(true);

    const descriptorSource = fs.readFileSync(path.join(openclawDir, 'dist', 'core-descriptors-test.js'), 'utf8');
    expect(descriptorSource).toContain('name: "mcpServerStatus/list"');
    expect(descriptorSource).toContain('scope: "operator.read"');

    const serverMethodsSource = fs.readFileSync(path.join(openclawDir, 'dist', 'server-methods-test.js'), 'utf8');
    expect(serverMethodsSource).toContain('import { g as getSessionMcpRuntimeManager } from "./pi-bundle-mcp-runtime-test.js";');
    expect(serverMethodsSource).toContain('const matchaMcpStatusGatewayHandlers = {');
    expect(serverMethodsSource).toContain('"mcpServerStatus/list": async ({ params, respond, context }) => {');
    expect(serverMethodsSource).toContain('context?.logGateway ?? createSubsystemLogger("gateway/mcp-status")');
    expect(serverMethodsSource).toContain('mcpServerStatus/list request sessionKey=');
    expect(serverMethodsSource).toContain('mcpServerStatus/list resolved sessionKey=');
    expect(serverMethodsSource).toContain('getBySessionKey(sessionKey)');
    expect(serverMethodsSource).toContain('await runtime.getCatalog()');
    expect(serverMethodsSource).toContain('loadSessionEntry(sessionKey)');
    expect(serverMethodsSource).toContain('manager.getOrCreate({');
    expect(serverMethodsSource).toContain('...matchaMcpStatusGatewayHandlers,');
    expect(serverMethodsSource).not.toContain('resolveCodexAppServerRuntimeOptions');
    expect(serverMethodsSource).not.toContain('requestCodexAppServerJson');

    const runtimeSource = fs.readFileSync(path.join(openclawDir, 'dist', 'pi-bundle-mcp-runtime-test.js'), 'utf8');
    expect(runtimeSource).toContain('getCachedCatalog() {');
    expect(runtimeSource).toContain('getBySessionKey(sessionKey) {');
  });

  it('keeps the OpenClaw MCP status gateway patch idempotent', () => {
    const openclawDir = createTempOpenClawPackage();
    applyOpenClawBundlePatches(openclawDir, { log: () => undefined });

    const results = applyOpenClawBundlePatches(openclawDir, { log: () => undefined });

    expect(results).toContainEqual(expect.objectContaining({
      id: 'openclaw-mcp-status-gateway-method',
      status: 'clean',
    }));
  });
});
