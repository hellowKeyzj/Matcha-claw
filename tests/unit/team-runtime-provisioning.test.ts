import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamProvisioningService } from '../../packages/openclaw-team-runtime-plugin/src/application/team-provisioning-service';
import { buildTeamManagedAgentId } from '../../packages/openclaw-team-runtime-plugin/src/domain/team-role';
import { TeamSkillPackageService } from '../../packages/openclaw-team-runtime-plugin/src/application/team-skill-package-service';

const fixturePath = path.resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0');

describe('TeamProvisioningService', () => {
  let storageRoot = '';
  let runtimeRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'team-runtime-provisioning-'));
    runtimeRoot = path.join(storageRoot, 'runs', 'run-provision');
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('writes role AGENTS.md and plugin-owned managed OpenClaw agent config projection', async () => {
    const packageResult = await new TeamSkillPackageService().validate(fixturePath);
    if (!packageResult.package) {
      throw new Error('fixture package did not validate');
    }
    const service = new TeamProvisioningService({ storageRoot });
    const teamSkillPackage = {
      ...packageResult.package,
      roles: packageResult.package.roles.map((role) => role.id === 'operator-designer' ? { ...role, tools: [...role.tools, 'bash'] } : role),
    };

    const result = await service.provisionRoleAgents({
      runtimeRoot,
      runId: 'run-provision',
      teamSkillPackage,
    });

    const operatorDesigner = teamSkillPackage.roles.find((role) => role.id === 'operator-designer')!;
    await expect(readFile(path.join(runtimeRoot, 'roles', 'operator-designer', 'AGENTS.md'), 'utf8')).resolves.toBe(operatorDesigner.agentsMd);
    const leaderAgentsMd = await readFile(path.join(runtimeRoot, 'leader', 'AGENTS.md'), 'utf8');
    expect(leaderAgentsMd).toContain('<team_workflow_orchestration>');
    expect(leaderAgentsMd).toContain('You are the TeamRun leader. Your job is orchestration, not role execution.');
    expect(leaderAgentsMd).toContain('Core contract:');
    expect(leaderAgentsMd).toContain('- team_plan_workflow describes only work assigned to concrete Team roles from the roster.');
    expect(leaderAgentsMd).toContain('Execution pattern:');
    expect(leaderAgentsMd).toContain('If workflow.md contains leader-only context extraction, perform that extraction yourself before calling team_plan_workflow.');
    expect(leaderAgentsMd).toContain('Role id rules:');
    expect(leaderAgentsMd).toContain('Invalid tasks[].roleId values include "leader", managed OpenClaw agent ids, display names, and ad-hoc aliases.');
    expect(leaderAgentsMd).toContain('Correct example:');
    expect(leaderAgentsMd).toContain('"roleId": "financial-analyst"');
    expect(leaderAgentsMd).toContain('Incorrect example:');
    expect(leaderAgentsMd).toContain('"roleId": "leader"');
    expect(leaderAgentsMd).toContain('This is invalid because "leader" is not a dispatchable Team role and leader tasks cannot complete via team_submit_artifact.');
    expect(leaderAgentsMd).toContain('Tool boundary:');
    expect(leaderAgentsMd).toContain('Your first orchestration action must be a successful team_plan_workflow call once you finish any leader-only context extraction.');
    expect(leaderAgentsMd).toContain('Until team_plan_workflow returns success, do not claim that roles were dispatched, do not say work is running in parallel, and do not say you are waiting for role outputs.');
    expect(leaderAgentsMd).toContain('As leader, do not call team_submit_artifact, team_update_task, or team_request_approval.');
    expect(leaderAgentsMd).toContain('</team_workflow_orchestration>');
    expect(leaderAgentsMd).not.toContain('team_dispatch_group');
    expect(leaderAgentsMd).not.toContain('team_dispatch_task');
    expect(leaderAgentsMd).toContain(`- operator-designer: ${buildTeamManagedAgentId('run-provision', 'operator-designer')}`);
    await expect(readFile(path.join(runtimeRoot, 'leader', 'workflow.md'), 'utf8')).resolves.toBe(packageResult.package.workflow.markdown);
    await expect(readFile(path.join(runtimeRoot, 'leader', 'bind.md'), 'utf8')).resolves.toBe(packageResult.package.bind.markdown);

    const managedConfig = JSON.parse(await readFile(path.join(runtimeRoot, 'managed', 'openclaw-agents.json'), 'utf8'));
    expect(managedConfig).toEqual({
      kind: 'matchaclaw-team-managed-openclaw-agents',
      version: 1,
      source: 'matchaclaw.team-runtime',
      runId: 'run-provision',
      leaderAgentId: buildTeamManagedAgentId('run-provision', 'leader'),
      agents: result.agentConfigProjection,
    });
    expect(managedConfig.agents.every((agent: { id: string }) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent.id))).toBe(true);
    expect(managedConfig.agents.every((agent: { sandbox: { mode: string; scope: string; workspaceAccess: string } }) => agent.sandbox.mode === 'off' && agent.sandbox.scope === 'agent' && agent.sandbox.workspaceAccess === 'rw')).toBe(true);
    const leaderAgentId = buildTeamManagedAgentId('run-provision', 'leader');
    expect(result.roles.map((role) => role.agentId)).not.toContain(leaderAgentId);
    expect(managedConfig.agents[0]).toEqual(expect.objectContaining({
      id: leaderAgentId,
      subagents: {
        allowAgents: result.roles.map((role) => role.agentId),
        requireAgentId: true,
      },
      managedBy: 'matchaclaw.team-runtime',
      managedRunId: 'run-provision',
      managedRoleId: 'leader',
      managedKind: 'team-role-agent',
      tools: expect.objectContaining({
        allow: expect.arrayContaining(['team_plan_workflow', 'team_submit_artifact', 'team_send_message', 'team_request_approval', 'team_update_task', 'bash']),
        deny: ['sessions_yield', 'subagents'],
      }),
    }));
    const kernelCoderConfig = managedConfig.agents.find((agent: { id: string }) => agent.id === buildTeamManagedAgentId('run-provision', 'kernel-coder'));
    expect(kernelCoderConfig).toEqual(expect.objectContaining({
      workspace: path.join(runtimeRoot, 'roles', 'kernel-coder'),
      managedBy: 'matchaclaw.team-runtime',
      managedRunId: 'run-provision',
      managedRoleId: 'kernel-coder',
      managedKind: 'team-role-agent',
      tools: expect.objectContaining({
        allow: expect.arrayContaining(['team_submit_artifact', 'team_send_message', 'team_request_approval', 'team_update_task']),
        deny: ['sessions_spawn', 'sessions_yield', 'subagents'],
      }),
    }));
    expect(kernelCoderConfig.subagents).toBeUndefined();
  });

  it('rejects role ids that cannot be provisioned as isolated path segments', async () => {
    const packageResult = await new TeamSkillPackageService().validate(fixturePath);
    if (!packageResult.package) {
      throw new Error('fixture package did not validate');
    }
    const service = new TeamProvisioningService({ storageRoot });

    await expect(service.provisionRoleAgents({
      runtimeRoot,
      runId: 'run-provision',
      teamSkillPackage: {
        ...packageResult.package,
        roles: [{ ...packageResult.package.roles[0]!, id: '../bad-role' }],
      },
    })).rejects.toThrow('Invalid Team role id for provisioning: ../bad-role');
  });

  it('rejects role ids reserved for the managed Team leader during provisioning', async () => {
    const packageResult = await new TeamSkillPackageService().validate(fixturePath);
    if (!packageResult.package) {
      throw new Error('fixture package did not validate');
    }
    const service = new TeamProvisioningService({ storageRoot });

    await expect(service.provisionRoleAgents({
      runtimeRoot,
      runId: 'run-provision',
      teamSkillPackage: {
        ...packageResult.package,
        roles: [{ ...packageResult.package.roles[0]!, id: 'leader' }],
      },
    })).rejects.toThrow('Team role id is reserved for provisioning: leader');
  });

  it('rejects duplicate managed agent ids during provisioning', async () => {
    const packageResult = await new TeamSkillPackageService().validate(fixturePath);
    if (!packageResult.package) {
      throw new Error('fixture package did not validate');
    }
    const service = new TeamProvisioningService({ storageRoot });

    await expect(service.provisionRoleAgents({
      runtimeRoot,
      runId: 'run-provision',
      teamSkillPackage: {
        ...packageResult.package,
        roles: [
          packageResult.package.roles[0]!,
          { ...packageResult.package.roles[1]!, id: packageResult.package.roles[0]!.id },
        ],
      },
    })).rejects.toThrow(`Duplicate Team managed agent id: ${buildTeamManagedAgentId('run-provision', 'operator-designer')}`);
  });

  it('rejects denied or undeclared role tools during provisioning', async () => {
    const packageResult = await new TeamSkillPackageService().validate(fixturePath);
    if (!packageResult.package) {
      throw new Error('fixture package did not validate');
    }
    const service = new TeamProvisioningService({ storageRoot });

    await expect(service.provisionRoleAgents({
      runtimeRoot,
      runId: 'run-provision',
      teamSkillPackage: {
        ...packageResult.package,
        dependencies: {
          ...packageResult.package.dependencies,
          tools: [
            ...packageResult.package.dependencies.tools,
            { name: 'sessions_spawn', required: true, purpose: 'Denied tool coverage' },
          ],
        },
        roles: [{ ...packageResult.package.roles[0]!, tools: [...packageResult.package.roles[0]!.tools, 'sessions_spawn'] }],
      },
    })).rejects.toThrow('Role operator-designer cannot allow denied managed agent tool: sessions_spawn');

    await expect(service.provisionRoleAgents({
      runtimeRoot,
      runId: 'run-provision-undeclared',
      teamSkillPackage: {
        ...packageResult.package,
        roles: [{ ...packageResult.package.roles[0]!, tools: [...packageResult.package.roles[0]!.tools, 'unknown_tool'] }],
      },
    })).rejects.toThrow('Role operator-designer references tool unknown_tool, but dependencies.yaml does not declare it.');
  });

  it('cleans up partially written role workspaces when provisioning fails', async () => {
    const packageResult = await new TeamSkillPackageService().validate(fixturePath);
    if (!packageResult.package) {
      throw new Error('fixture package did not validate');
    }
    const service = new TeamProvisioningService({ storageRoot });

    await writeFile(path.join(storageRoot, 'agents-blocker'), 'block', 'utf8');
    Object.defineProperty(service, 'leaderAgentDir', {
      value: () => path.join(storageRoot, 'agents-blocker'),
    });

    await expect(service.provisionRoleAgents({
      runtimeRoot,
      runId: 'run-provision',
      teamSkillPackage: packageResult.package,
    })).rejects.toThrow();

    await expect(readFile(path.join(runtimeRoot, 'roles', 'operator-designer', 'AGENTS.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(runtimeRoot, 'roles.json'), 'utf8')).rejects.toThrow();
  });
});
