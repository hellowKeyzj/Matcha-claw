import { describe, expect, it } from 'vitest';
import {
  buildRuntimeLaunchCommandRequest,
  validateRemoteRuntimeLaunchSpec,
  type BuildRuntimeLaunchCommandRequestInput,
} from '../../runtime-host/application/remote-fleet/remote-fleet-runtime-launch';
import type {
  RemoteFleetNodeRecord,
  RuntimeInstanceRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';

const now = '2026-07-06T00:00:00.000Z';

function createNode(overrides: Partial<RemoteFleetNodeRecord> = {}): RemoteFleetNodeRecord {
  return {
    id: 'node-launch',
    displayName: 'Launch Node',
    targetKind: 'container',
    labels: [],
    enabled: true,
    publicConfig: {},
    secretRefs: {},
    health: { reason: 'unknown' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createRuntime(overrides: Partial<RuntimeInstanceRecord> = {}): RuntimeInstanceRecord {
  return {
    id: 'runtime-launch',
    nodeId: 'node-launch',
    displayName: 'Launch Runtime',
    runtimeKind: 'openclaw',
    lifecycle: { reason: 'stopped' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createBuildInput(overrides: Partial<BuildRuntimeLaunchCommandRequestInput> = {}): BuildRuntimeLaunchCommandRequestInput {
  const node = createNode({
    publicConfig: {
      runtimeLaunch: {
        openclaw: { launchMode: 'native-runtime', configProfile: 'remote-dev' },
        env: { MATCHA_RUNTIME_MODE: 'remote' },
        secretEnv: { ANTHROPIC_API_KEY: 'anthropicApiKey' },
        resources: { cpuCores: 2, memoryMb: 4096, gpuCount: 0, ephemeralStorageMb: 8192 },
        workspaces: [{
          source: { kind: 'workspace-ref', workspaceId: 'workspace-1' },
          targetPath: '/workspace',
          access: 'read-write',
          purpose: 'workspace',
        }],
        ports: [{
          name: 'gateway',
          targetPort: 1455,
          protocol: 'http',
          exposure: 'fleet-private',
        }],
      },
    },
    secretRefs: { anthropicApiKey: { kind: 'secret-ref', ref: 'remote-fleet://node-launch/anthropic' } },
  });

  return {
    commandId: 'command-launch',
    runtime: createRuntime(),
    node,
    timeoutMs: 30_000,
    ...overrides,
  };
}

describe('remote fleet runtime launch spec', () => {
  it('builds an OpenClaw start-runtime command request without secret values', () => {
    const result = buildRuntimeLaunchCommandRequest(createBuildInput());

    expect(result.resultType).toBe('built');
    if (result.resultType !== 'built') return;
    expect(result.request).toMatchObject({
      commandId: 'command-launch',
      kind: 'start-runtime',
      timeoutMs: 30_000,
      runtime: expect.objectContaining({ id: 'runtime-launch', runtimeKind: 'openclaw' }),
      publicConfig: {
        runtimeLaunch: expect.objectContaining({
          specVersion: 'remote-runtime-launch/v1',
          runtimeKind: 'openclaw',
          provider: { kind: 'openclaw', launchMode: 'native-runtime', configProfile: 'remote-dev' },
          resourceLimits: { cpuCores: 2, memoryMb: 4096, gpuCount: 0, ephemeralStorageMb: 8192 },
          workspaceMounts: [{
            source: { kind: 'workspace-ref', workspaceId: 'workspace-1' },
            targetPath: '/workspace',
            access: 'read-write',
            purpose: 'workspace',
          }],
          portExposures: [{
            name: 'gateway',
            targetPort: 1455,
            protocol: 'http',
            exposure: 'fleet-private',
          }],
        }),
      },
      payload: expect.objectContaining({
        payloadType: 'remote-runtime-launch',
        launchCommand: expect.objectContaining({
          commandVersion: 'remote-runtime-launch-command/v1',
          commandType: 'start-runtime',
          runtimeKind: 'openclaw',
          executable: { kind: 'openclaw-runtime', launchMode: 'native-runtime', configProfile: 'remote-dev' },
          environment: {
            public: [{ name: 'MATCHA_RUNTIME_MODE', value: 'remote' }],
            secretPlaceholders: [{ envName: 'ANTHROPIC_API_KEY', secretRefName: 'anthropicApiKey', secretRef: { kind: 'secret-ref', ref: 'remote-fleet://node-launch/anthropic' }, placeholder: '{{remote-fleet.secret-env.ANTHROPIC_API_KEY}}' }],
          },
        }),
        readiness: expect.objectContaining({
          expectedRuntimeId: 'runtime-launch',
          expectedNodeId: 'node-launch',
          expectedRuntimeKind: 'openclaw',
          ackAdvancesLifecycle: true,
        }),
        capabilitySync: {
          syncAfterReady: true,
          expectedRuntimeId: 'runtime-launch',
          strategy: 'runtime-agent-capabilities-sync',
          capabilityKinds: ['agent-runtime-endpoint', 'session-runtime', 'tool-capabilities', 'plugin-capabilities'],
        },
        unsupportedReasons: [],
      }),
    });
    expect(result.launchSpec.environment.public).toEqual([{ name: 'MATCHA_RUNTIME_MODE', value: 'remote' }]);
    expect(result.launchSpec.environment.secrets).toEqual([{ name: 'ANTHROPIC_API_KEY', secretRefName: 'anthropicApiKey', secretRef: { kind: 'secret-ref', ref: 'remote-fleet://node-launch/anthropic' }, placeholder: '{{remote-fleet.secret-env.ANTHROPIC_API_KEY}}' }]);
    expect(result.payload.readiness.requiredSignals.map((item) => item.signal)).toEqual(['process-started', 'runtime-endpoint-ready', 'health-probe-ready']);
    expect(result.request.publicConfig.runtimeLaunch).toMatchObject({
      readiness: expect.objectContaining({ ackAdvancesLifecycle: true }),
      capabilitySync: expect.objectContaining({ strategy: 'runtime-agent-capabilities-sync' }),
    });
    expect(result.request.node.secretRefs).toEqual({ anthropicApiKey: { kind: 'secret-ref', ref: 'remote-fleet://node-launch/anthropic' } });
    expect(JSON.stringify(result.request)).not.toContain('sk-ant');
    expect(JSON.stringify(result.request)).not.toContain('secret-value');
  });

  it('builds matcha-agent and plugin-runtime provider-specific executable commands', () => {
    const matchaAgentResult = buildRuntimeLaunchCommandRequest(createBuildInput({
      runtime: createRuntime({ runtimeKind: 'matcha-agent' }),
      node: createNode({ publicConfig: { runtimeLaunch: { matchaAgent: { launchMode: 'app-server', appServerBasePath: '/matcha-agent' } } } }),
    }));
    const pluginRuntimeResult = buildRuntimeLaunchCommandRequest(createBuildInput({
      runtime: createRuntime({ runtimeKind: 'plugin-runtime' }),
      node: createNode({ publicConfig: { runtimeLaunch: { pluginRuntime: { pluginId: 'memory-lancedb-pro' } } } }),
    }));

    expect(matchaAgentResult.resultType).toBe('built');
    if (matchaAgentResult.resultType !== 'built') return;
    expect(matchaAgentResult.launchSpec).toEqual(expect.objectContaining({
      runtimeKind: 'matcha-agent',
      provider: { kind: 'matcha-agent', launchMode: 'app-server', appServerBasePath: '/matcha-agent' },
    }));
    expect(matchaAgentResult.payload.launchCommand).toMatchObject({
      runtimeKind: 'matcha-agent',
      provider: { kind: 'matcha-agent', launchMode: 'app-server', appServerBasePath: '/matcha-agent' },
      executable: { kind: 'matcha-agent-runtime', launchMode: 'app-server', appServerBasePath: '/matcha-agent' },
      capabilitySync: {
        syncAfterReady: true,
        expectedRuntimeId: 'runtime-launch',
        strategy: 'runtime-agent-capabilities-sync',
        capabilityKinds: ['agent-runtime-endpoint', 'session-runtime', 'tool-capabilities'],
      },
    });
    expect(matchaAgentResult.payload.readiness.requiredSignals.map((item) => item.signal)).toEqual(['process-started', 'runtime-endpoint-ready', 'health-probe-ready']);
    expect(matchaAgentResult.payload.unsupportedReasons).toEqual([]);

    expect(pluginRuntimeResult.resultType).toBe('built');
    if (pluginRuntimeResult.resultType !== 'built') return;
    expect(pluginRuntimeResult.launchSpec).toEqual(expect.objectContaining({
      runtimeKind: 'plugin-runtime',
      provider: { kind: 'plugin-runtime', pluginId: 'memory-lancedb-pro' },
    }));
    expect(pluginRuntimeResult.payload.launchCommand).toMatchObject({
      runtimeKind: 'plugin-runtime',
      provider: { kind: 'plugin-runtime', pluginId: 'memory-lancedb-pro' },
      executable: { kind: 'openclaw-plugin-runtime', pluginId: 'memory-lancedb-pro', entrypoint: 'runtime' },
      capabilitySync: {
        syncAfterReady: true,
        expectedRuntimeId: 'runtime-launch',
        strategy: 'runtime-agent-capabilities-sync',
        capabilityKinds: ['agent-runtime-endpoint', 'plugin-capabilities'],
      },
    });
    expect(pluginRuntimeResult.payload.readiness.requiredSignals.map((item) => item.signal)).toEqual(['process-started', 'runtime-endpoint-ready']);
    expect(pluginRuntimeResult.payload.unsupportedReasons).toEqual([]);
  });

  it('rejects invalid secret refs, node mismatches, and non-policy-friendly requests', () => {
    const result = validateRemoteRuntimeLaunchSpec({
      runtime: createRuntime({ nodeId: 'other-node', runtimeKind: 'plugin-runtime' }),
      node: createNode({
        publicConfig: {
          runtimeLaunch: {
            pluginRuntime: {},
            env: { lowerCase: 'bad', API_TOKEN: 'Authorization: Bearer runtime-secret' },
            secretEnv: { TOKEN: 'missingSecret' },
            resources: { memoryMb: 0 },
            workspaces: [
              { source: { kind: 'node-path', path: '' }, targetPath: '', access: 'write' },
              { source: { kind: 'ephemeral-volume', name: 'scratch' }, targetPath: '/scratch' },
            ],
            ports: [
              { name: 'bad-port', targetPort: 70_000, protocol: 'smtp', exposure: 'internet' },
              { name: 'missing-policy', targetPort: 8080 },
            ],
          },
        },
      }),
    });

    expect(result.resultType).toBe('invalid');
    if (result.resultType !== 'invalid') return;
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'runtime.nodeId', reason: 'node-mismatch' }),
      expect.objectContaining({ path: 'publicConfig.runtimeLaunch.env.API_TOKEN', reason: 'unsafe-public-config' }),
      expect.objectContaining({ path: 'runtimeLaunch.pluginRuntime.pluginId', reason: 'missing-required-field' }),
      expect.objectContaining({ path: 'runtimeLaunch.env.lowerCase', reason: 'invalid-value' }),
      expect.objectContaining({ path: 'runtimeLaunch.secretEnv.TOKEN', reason: 'missing-secret-ref' }),
      expect.objectContaining({ path: 'runtimeLaunch.resources.memoryMb', reason: 'invalid-value' }),
      expect.objectContaining({ path: 'runtimeLaunch.workspaces.0.source.path', reason: 'missing-required-field' }),
      expect.objectContaining({ path: 'runtimeLaunch.workspaces.0.access', reason: 'invalid-value' }),
      expect.objectContaining({ path: 'runtimeLaunch.workspaces.1.access', reason: 'missing-required-field' }),
      expect.objectContaining({ path: 'runtimeLaunch.ports.0.targetPort', reason: 'invalid-value' }),
      expect.objectContaining({ path: 'runtimeLaunch.ports.0.protocol', reason: 'invalid-value' }),
      expect.objectContaining({ path: 'runtimeLaunch.ports.0.exposure', reason: 'invalid-value' }),
      expect.objectContaining({ path: 'runtimeLaunch.ports.1.protocol', reason: 'missing-required-field' }),
      expect.objectContaining({ path: 'runtimeLaunch.ports.1.exposure', reason: 'missing-required-field' }),
    ]));
  });
});
