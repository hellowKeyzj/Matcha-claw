import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamProvisioningService } from '../../packages/openclaw-team-runtime-plugin/src/application/team-provisioning-service';
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

    const result = await service.provisionRoleAgents({
      runtimeRoot,
      runId: 'run-provision',
      teamSkillPackage: packageResult.package,
    });

    const operatorDesigner = packageResult.package.roles.find((role) => role.id === 'operator-designer')!;
    await expect(readFile(path.join(runtimeRoot, 'roles', 'operator-designer', 'AGENTS.md'), 'utf8')).resolves.toBe(operatorDesigner.agentsMd);
    await expect(readFile(path.join(runtimeRoot, 'leader', 'workflow.md'), 'utf8')).resolves.toBe(packageResult.package.workflow.markdown);
    await expect(readFile(path.join(runtimeRoot, 'leader', 'bind.md'), 'utf8')).resolves.toBe(packageResult.package.bind.markdown);

    const managedConfig = JSON.parse(await readFile(path.join(runtimeRoot, 'managed', 'openclaw-agents.json'), 'utf8'));
    expect(managedConfig).toEqual({
      kind: 'matchaclaw-team-managed-openclaw-agents',
      version: 1,
      source: 'matchaclaw.team-runtime',
      runId: 'run-provision',
      leaderAgentId: 'matchaclaw-team:run-provision:leader',
      agents: result.agentConfigProjection,
    });
    expect(managedConfig.agents[0]).toEqual(expect.objectContaining({
      id: 'matchaclaw-team:run-provision:leader',
      subagents: {
        allowAgents: result.roles.map((role) => role.agentId),
        requireAgentId: true,
      },
      managedBy: 'matchaclaw.team-runtime',
      managedRunId: 'run-provision',
      managedRoleId: 'leader',
      managedKind: 'team-role-agent',
      tools: expect.objectContaining({
        alsoAllow: ['sessions_spawn', 'sessions_yield', 'subagents'],
      }),
    }));
    const kernelCoderConfig = managedConfig.agents.find((agent: { id: string }) => agent.id === 'matchaclaw-team:run-provision:kernel-coder');
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
    })).rejects.toThrow('Duplicate Team managed agent id: matchaclaw-team:run-provision:operator-designer');
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
          requiredTools: [...packageResult.package.dependencies.requiredTools, 'sessions_spawn'],
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
