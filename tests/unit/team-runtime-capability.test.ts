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
  importTeamRunGraphYaml,
  listTeamRuns,
  planTeamDependencies,
  provisionTeamAgents,
  readTeamRunDiagnostics,
  readTeamRunSnapshot,
  resolveTeamApproval,
  resumeTeam,
  saveTeamRunGraphProjection,
  submitTeamRunDecision,
  submitTeamRunGraphPatch,
  submitTeamRunNodeEvent,
  submitTeamRunRoleMessage,
  validateTeamSkillPackage,
} from '@/services/openclaw/team-runtime-client';

type ClientCase = {
  name: string;
  operationId: string;
  target: Record<string, unknown>;
  input: Record<string, unknown>;
  invoke: () => Promise<unknown>;
};

const scope = { kind: 'global' };
const packagePath = 'teams/one';
const teamId = 'team:one';
const runId = 'run:one';

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
  'team.roleMessageSubmit',
  'team.nodePromptRetryDue',
  'team.nodePromptSettled',
  'team.nodeEvent',
  'team.runDiagnostics',
  'team.runDecisionSubmit',
  'team.resume',
  'team.approvalResolve',
  'team.runCancel',
  'team.runDelete',
] as const;

const MISSING_CLIENT_OPERATION_IDS = [
  'team.triggerList',
  'team.webhookTriggerFire',
  'team.graphContext',
  'team.nodePromptRetryDue',
  'team.nodePromptSettled',
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
    input: { teamId, packagePath, idempotencyKey: 'provision:one', sourceType: 'manual', manualTeam },
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
    name: 'team resume with idempotency',
    operationId: 'team.resume',
    target: { kind: 'team', teamId },
    input: { teamId, idempotencyKey: 'resume:one' },
    invoke: () => resumeTeam({ teamId, idempotencyKey: 'resume:one' }),
  },
  {
    name: 'run decision',
    operationId: 'team.runDecisionSubmit',
    target: { kind: 'team-run', runId },
    input: { runId, decision: 'retry', note: 'retry once', idempotencyKey: 'decision:one' },
    invoke: () => submitTeamRunDecision({ runId, decision: 'retry', note: 'retry once', idempotencyKey: 'decision:one' }),
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
    name: 'snapshot with event cursor projection',
    operationId: 'team.runSnapshot',
    target: { kind: 'team-run', runId },
    input: { runId, eventCursor: 7, eventLimit: 20 },
    invoke: () => readTeamRunSnapshot({ runId, eventCursor: 7, eventLimit: 20 }),
  },
  {
    name: 'diagnostics projection',
    operationId: 'team.runDiagnostics',
    target: { kind: 'team-run', runId },
    input: { runId },
    invoke: () => readTeamRunDiagnostics({ runId }),
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
    name: 'role message',
    operationId: 'team.roleMessageSubmit',
    target: { kind: 'team-run', runId },
    input: { runId, roleId: 'leader', text: 'hello', idempotencyKey: 'message:one' },
    invoke: () => submitTeamRunRoleMessage({ runId, roleId: 'leader', text: 'hello', idempotencyKey: 'message:one' }),
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
  it('keeps the complete legacy 25-operation catalog and current client gap explicit', () => {
    const covered = new Set(cases.map(({ operationId }) => operationId));
    expect(LEGACY_OPERATION_IDS).toHaveLength(25);
    expect(MISSING_CLIENT_OPERATION_IDS).toHaveLength(5);
    expect(MISSING_CLIENT_OPERATION_IDS.every((operationId) => !covered.has(operationId))).toBe(true);
    expect(new Set([...covered, ...MISSING_CLIENT_OPERATION_IDS])).toEqual(new Set(LEGACY_OPERATION_IDS));
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
});
