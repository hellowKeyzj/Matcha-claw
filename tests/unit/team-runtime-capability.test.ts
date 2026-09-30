import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hostApiFetch, resolveSingleCapabilityScope } = vi.hoisted(() => ({
  hostApiFetch: vi.fn(),
  resolveSingleCapabilityScope: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch,
  resolveSingleCapabilityScope,
}));

import {
  cancelTeamRun,
  createTeamRun,
  deleteTeamInstance,
  deleteTeamRun,
  exportTeamRunGraphYaml,
  fireTeamRunTrigger,
  fireTeamWebhookTrigger,
  importTeamRunGraphYaml,
  listTeamRuns,
  listTeamRunTriggers,
  planTeamDependencies,
  provisionTeamAgents,
  readTeamRunDiagnostics,
  readTeamRunGraphContext,
  readTeamRunSnapshot,
  resolveTeamApproval,
  resumeTeam,
  saveTeamRunGraphProjection,
  submitTeamRunDecision,
  submitTeamRunGraphPatch,
  submitTeamRunNodeEvent,
  validateTeamSkillPackage,
  wakeDueTeamRunNodePromptRetries,
} from '@/services/openclaw/team-runtime-client';

type ClientCase = {
  name: string;
  operationId: string;
  target: Record<string, unknown> | null;
  input: Record<string, unknown>;
  invoke: () => Promise<unknown>;
};

const scope = { kind: 'global' };
const packagePath = 'teams/one';
const teamId = 'team:one';
const runId = 'run:one';
const selectionId = `teamskill:v1:${'a'.repeat(64)}`;

const manualTeam = {
  name: 'One',
  description: 'verification team',
  version: '1.0.0',
  members: [{
    agentId: 'agent:one',
    agentName: 'Leader',
    workspace: 'workspace:one',
    roleId: 'leader',
    skills: [],
    tools: [],
    isLeader: true,
  }],
};

const manualTeamInput = {
  name: 'One',
  description: 'verification team',
  version: '1.0.0',
  members: [{
    agentId: 'agent:one',
    agentName: 'Leader',
    workspace: 'workspace:one',
    roleId: 'leader',
    skills: [],
    tools: [],
    isLeader: true,
  }],
};

const graph = { nodes: [], edges: [], status: 'ready' };
const patch = { operations: [{ op: 'set_metadata' as const, metadata: { source: 'verification' } }] };

const LEGACY_OPERATION_IDS = [
  'team.packageValidate',
  'team.dependencyPlan',
  'team.provisionAgents',
  'team.delete',
  'team.runCreate',
  'team.runList',
  'team.triggerList',
  'team.webhookTriggerFire',
  'team.runSnapshot',
  'team.graphSave',
  'team.graphPatch',
  'team.graphContext',
  'team.graphExportYaml',
  'team.graphImportYaml',
  'team.triggerFire',
  'team.nodePromptRetryDue',
  'team.nodeEvent',
  'team.runDiagnostics',
  'team.runDecisionSubmit',
  'team.resume',
  'team.approvalResolve',
  'team.runCancel',
  'team.runDelete',
] as const;

const cases: ClientCase[] = [
  {
    name: 'package validation',
    operationId: 'team.packageValidate',
    target: { kind: 'team', packagePath },
    input: { packagePath },
    invoke: () => validateTeamSkillPackage({ packagePath }),
  },
  {
    name: 'dependency planning',
    operationId: 'team.dependencyPlan',
    target: { kind: 'team', packagePath },
    input: { packagePath },
    invoke: () => planTeamDependencies({ packagePath }),
  },
  {
    name: 'agent provisioning',
    operationId: 'team.provisionAgents',
    target: { kind: 'team', teamId, packagePath },
    input: { teamId, packagePath, idempotencyKey: 'provision:one', sourceType: 'manual', manualTeam: manualTeamInput },
    invoke: () => provisionTeamAgents({
      teamId,
      packagePath,
      idempotencyKey: 'provision:one',
      sourceType: 'manual',
      manualTeam,
    }),
  },
  {
    name: 'team deletion',
    operationId: 'team.delete',
    target: { kind: 'team', teamId },
    input: { kind: 'team', teamId },
    invoke: () => deleteTeamInstance({ teamId }),
  },
  {
    name: 'run creation with package path and requested run id',
    operationId: 'team.runCreate',
    target: { kind: 'team', packagePath, teamId },
    input: { teamId, packagePath, runId, idempotencyKey: 'create:one', sourceType: 'manual' },
    invoke: () => createTeamRun({ teamId, packagePath, runId, idempotencyKey: 'create:one', sourceType: 'manual' }),
  },
  {
    name: 'run listing',
    operationId: 'team.runList',
    target: { kind: 'team', teamId },
    input: { teamId },
    invoke: () => listTeamRuns({ teamId }),
  },
  {
    name: 'trigger listing',
    operationId: 'team.triggerList',
    target: { kind: 'team', teamId },
    input: {},
    invoke: () => listTeamRunTriggers({ teamId }),
  },
  {
    name: 'webhook trigger fire',
    operationId: 'team.webhookTriggerFire',
    target: { kind: 'team' },
    input: { webhookPath: '/webhooks/team-one', idempotencyKey: 'webhook:one' },
    invoke: () => fireTeamWebhookTrigger({ webhookPath: '/webhooks/team-one', idempotencyKey: 'webhook:one' }),
  },
  {
    name: 'snapshot with event cursor projection',
    operationId: 'team.runSnapshot',
    target: { kind: 'team-run', runId },
    input: { runId, eventCursor: 7, eventLimit: 20 },
    invoke: () => readTeamRunSnapshot({ runId, eventCursor: 7, eventLimit: 20 }),
  },
  {
    name: 'graph save',
    operationId: 'team.graphSave',
    target: { kind: 'team-run', runId },
    input: { runId, graph, idempotencyKey: 'graph:save:one' },
    invoke: () => saveTeamRunGraphProjection({ runId, graph, idempotencyKey: 'graph:save:one' }),
  },
  {
    name: 'graph patch',
    operationId: 'team.graphPatch',
    target: { kind: 'team-run', runId },
    input: { runId, summary: 'set metadata', patch, idempotencyKey: 'graph:patch:one' },
    invoke: () => submitTeamRunGraphPatch({ runId, summary: 'set metadata', patch, idempotencyKey: 'graph:patch:one' }),
  },
  {
    name: 'graph context',
    operationId: 'team.graphContext',
    target: { kind: 'team-run', teamId, runId },
    input: { teamId, runId, view: 'currentNode', nodeExecutionId: 'start:attempt:1' },
    invoke: () => readTeamRunGraphContext({ teamId, runId, view: 'currentNode', nodeExecutionId: 'start:attempt:1' }),
  },
  {
    name: 'graph export',
    operationId: 'team.graphExportYaml',
    target: { kind: 'team-run', runId },
    input: { runId },
    invoke: () => exportTeamRunGraphYaml({ runId }),
  },
  {
    name: 'graph import',
    operationId: 'team.graphImportYaml',
    target: { kind: 'team-run', runId },
    input: { runId, yaml: 'version: 1\n', idempotencyKey: 'graph:import:one' },
    invoke: () => importTeamRunGraphYaml({ runId, yaml: 'version: 1\n', idempotencyKey: 'graph:import:one' }),
  },
  {
    name: 'start trigger',
    operationId: 'team.triggerFire',
    target: { kind: 'team-run', runId },
    input: { runId, startNodeId: 'start', triggerSource: 'webhook', payloadSummary: 'ready', idempotencyKey: 'trigger:one' },
    invoke: () => fireTeamRunTrigger({
      runId,
      startNodeId: 'start',
      triggerSource: 'webhook',
      payloadSummary: 'ready',
      idempotencyKey: 'trigger:one',
    }),
  },
  {
    name: 'node prompt retry due',
    operationId: 'team.nodePromptRetryDue',
    target: { kind: 'team-run', runId },
    input: { runId },
    invoke: () => wakeDueTeamRunNodePromptRetries({ runId }),
  },
  {
    name: 'node event',
    operationId: 'team.nodeEvent',
    target: { kind: 'team-run', runId },
    input: { runId, nodeExecutionId: 'start:attempt:1', event: 'progress', summary: 'started', idempotencyKey: 'event:one' },
    invoke: () => submitTeamRunNodeEvent({
      runId,
      nodeExecutionId: 'start:attempt:1',
      event: 'progress',
      summary: 'started',
      idempotencyKey: 'event:one',
    }),
  },
  {
    name: 'diagnostics projection',
    operationId: 'team.runDiagnostics',
    target: { kind: 'team-run', runId },
    input: { runId },
    invoke: () => readTeamRunDiagnostics({ runId }),
  },
  {
    name: 'run decision',
    operationId: 'team.runDecisionSubmit',
    target: { kind: 'team-run', runId },
    input: { runId, decision: 'retry', note: 'retry once', idempotencyKey: 'decision:one' },
    invoke: () => submitTeamRunDecision({ runId, decision: 'retry', note: 'retry once', idempotencyKey: 'decision:one' }),
  },
  {
    name: 'team resume with idempotency',
    operationId: 'team.resume',
    target: { kind: 'team', teamId },
    input: { teamId, idempotencyKey: 'resume:one' },
    invoke: () => resumeTeam({ teamId, idempotencyKey: 'resume:one' }),
  },
  {
    name: 'approval decision',
    operationId: 'team.approvalResolve',
    target: { kind: 'team-approval', runId, approvalId: 'approval:one' },
    input: { runId, approvalId: 'approval:one', decision: 'approve', note: 'approved', idempotencyKey: 'approval:one' },
    invoke: () => resolveTeamApproval({
      runId,
      approvalId: 'approval:one',
      decision: 'approve',
      note: 'approved',
      idempotencyKey: 'approval:one',
    }),
  },
  {
    name: 'cancel with reason',
    operationId: 'team.runCancel',
    target: { kind: 'team-run', runId },
    input: { runId, reason: 'operator requested', idempotencyKey: 'cancel:one' },
    invoke: () => cancelTeamRun({ runId, reason: 'operator requested', idempotencyKey: 'cancel:one' }),
  },
  {
    name: 'run deletion without idempotency key',
    operationId: 'team.runDelete',
    target: { kind: 'team-run', runId },
    input: { runId },
    invoke: () => deleteTeamRun({ runId }),
  },
];

beforeEach(() => {
  hostApiFetch.mockReset();
  resolveSingleCapabilityScope.mockReset();
  resolveSingleCapabilityScope.mockResolvedValue(scope);
  hostApiFetch.mockRejectedValue({
    code: 'TEAM_RUNTIME_UNAVAILABLE',
    status: 503,
    message: 'Team runtime is unavailable',
  });
});

describe('Team runtime client compatibility verification', () => {
  it('covers all 23 legacy operation ids through exported client wrappers', () => {
    const covered = new Set(cases.map(({ operationId }) => operationId));
    expect(LEGACY_OPERATION_IDS).toHaveLength(23);
    expect(cases).toHaveLength(23);
    expect(covered.size).toBe(23);
    expect(covered).toEqual(new Set(LEGACY_OPERATION_IDS));
  });

  it.each(cases)('$name preserves the legacy capability request and does not fake success', async (fixture) => {
    await expect(fixture.invoke()).rejects.toMatchObject({
      code: 'TEAM_RUNTIME_UNAVAILABLE',
      status: 503,
    });

    expect(resolveSingleCapabilityScope).toHaveBeenCalledWith('team.runtime');
    expect(hostApiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = hostApiFetch.mock.calls[0] as [string, { body: string; method: string; timeoutMs: number }];
    expect(path).toBe('/api/capabilities/execute');
    expect(init.method).toBe('POST');
    expect(init.timeoutMs).toBe(60_000);
    expect(JSON.parse(init.body)).toEqual({
      id: 'team.runtime',
      operationId: fixture.operationId,
      scope,
      target: fixture.target,
      input: fixture.input,
    });
  });

  it('decodes Rust sealed package validation DTOs', async () => {
    const valid = {
      status: 'valid',
      package: {
        selectionId,
        name: 'One',
        version: '1.0.0',
        kind: 'team-skill',
        description: 'verification team',
      },
    };
    hostApiFetch.mockResolvedValueOnce(valid);
    await expect(validateTeamSkillPackage({ packagePath })).resolves.toEqual(valid);

    hostApiFetch.mockResolvedValueOnce({ status: 'invalid' });
    await expect(validateTeamSkillPackage({ packagePath })).resolves.toEqual({ status: 'invalid' });

    hostApiFetch.mockResolvedValueOnce({ status: 'unavailable' });
    await expect(validateTeamSkillPackage({ packagePath })).resolves.toEqual({ status: 'unavailable' });
  });

  it('rejects old validation DTOs and outcome-unknown mutation projections', async () => {
    hostApiFetch.mockResolvedValueOnce({ valid: true, package: {}, errors: [], warnings: [] });
    await expect(validateTeamSkillPackage({ packagePath })).rejects.toThrow('Team runtime response is unavailable');

    hostApiFetch.mockResolvedValueOnce({ runId, state: 'outcome_unknown' });
    await expect(cancelTeamRun({ runId, idempotencyKey: 'cancel:unknown' })).rejects.toThrow('Team runtime response is unavailable');

    hostApiFetch.mockResolvedValueOnce({ runId, state: 'outcome_unknown' });
    await expect(deleteTeamRun({ runId })).rejects.toThrow('Invalid call receipt');

    hostApiFetch.mockResolvedValueOnce({ runId, outcome: 'outcome-unknown' });
    await expect(exportTeamRunGraphYaml({ runId })).rejects.toThrow('Team runtime response is unavailable');
  });

  it('rejects team delete outcome-unknown as an admission receipt', async () => {
    const projection = { teamId, state: 'outcome_unknown' };
    hostApiFetch.mockResolvedValueOnce(projection);

    await expect(deleteTeamInstance({ teamId })).rejects.toThrow('Invalid call receipt');
  });

  it('decodes Rust graph export projection without requiring the old success wrapper', async () => {
    const projection = { runId, fileName: `${runId}.yaml`, yaml: 'version: 1\n' };
    hostApiFetch.mockResolvedValueOnce(projection);
    await expect(exportTeamRunGraphYaml({ runId })).resolves.toEqual(projection);
  });

  it('forwards terminal node event receipt fields', async () => {
    hostApiFetch.mockRejectedValueOnce({
      code: 'TEAM_RUNTIME_UNAVAILABLE',
      status: 503,
      message: 'Team runtime is unavailable',
    });

    await expect(submitTeamRunNodeEvent({
      runId,
      nodeExecutionId: 'start:attempt:1',
      event: 'complete',
      summary: 'done',
      idempotencyKey: 'event:complete:one',
      outputPort: 'done',
      deliveryId: 'delivery:one',
      receipt: 'receipt:one',
      nodeId: 'start',
      attemptNumber: 1,
    })).rejects.toMatchObject({ status: 503 });

    const [, init] = hostApiFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body).input).toEqual({
      runId,
      nodeExecutionId: 'start:attempt:1',
      event: 'complete',
      summary: 'done',
      idempotencyKey: 'event:complete:one',
      outputPort: 'done',
      deliveryId: 'delivery:one',
      receipt: 'receipt:one',
      nodeId: 'start',
      attemptNumber: 1,
    });
  });
});
