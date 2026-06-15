import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamProvisioningService } from '../../packages/openclaw-team-runtime-plugin/src/application/team-provisioning-service';
import { TeamSkillPackageService } from '../../packages/openclaw-team-runtime-plugin/src/application/team-skill-package-service';
import { buildTeamManagedAgentId } from '../../packages/openclaw-team-runtime-plugin/src/domain/team-role';
import { TeamManagedAgentConfigWorkflow } from '../../runtime-host/application/team-skill/team-managed-agent-config-workflow';

const fixturePath = path.resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0');

describe('Team workspace e2e: provisioning → openclaw.json → file readability', () => {
  let storageRoot = '';
  let runtimeRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'team-workspace-e2e-'));
    runtimeRoot = path.join(storageRoot, 'runs', 'run-e2e');
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('writes files to leader workspace AND config workspace points to same directory', async () => {
    const packageResult = await new TeamSkillPackageService().validate(fixturePath);
    if (!packageResult.package) {
      throw new Error('fixture package did not validate');
    }

    // Step 1: provision (writes files + managed config)
    const provisioningService = new TeamProvisioningService({ storageRoot });
    const provisioned = await provisioningService.provisionRoleAgents({
      runtimeRoot,
      runId: 'run-e2e',
      teamSkillPackage: packageResult.package,
    });

    const expectedLeaderWorkspace = path.join(runtimeRoot, 'leader');

    // Step 2: verify files exist at the expected workspace path
    const files = ['AGENTS.md', 'SKILL.md', 'workflow.md', 'bind.md', 'dependencies.json'] as const;
    for (const file of files) {
      const filePath = path.join(expectedLeaderWorkspace, file);
      const content = await readFile(filePath, 'utf8');
      expect(content.length, `${file} should not be empty`).toBeGreaterThan(0);
    }

    // Step 3: verify managedConfigProjection workspace matches the file location
    const leaderProjection = provisioned.managedConfigProjection.agents.find(
      (agent) => agent.id === buildTeamManagedAgentId('run-e2e', 'leader'),
    );
    expect(leaderProjection).toBeDefined();
    expect(leaderProjection!.workspace).toBe(expectedLeaderWorkspace);

    // Step 4: apply config to openclaw.json and verify workspace is correct
    const openclawConfig: Record<string, unknown> = { agents: { list: [] } };
    const configWorkflow = new TeamManagedAgentConfigWorkflow({
      configRepository: {
        updateDirty: async (mutate) => (await mutate(openclawConfig)).result,
      },
    });

    await configWorkflow.apply(provisioned.managedConfigProjection);

    // Step 5: verify openclaw.json contains correct workspace for leader agent
    const agentsList = (openclawConfig.agents as { list: Array<Record<string, unknown>> }).list;
    const leaderConfig = agentsList.find(
      (agent) => agent.id === buildTeamManagedAgentId('run-e2e', 'leader'),
    );
    expect(leaderConfig).toBeDefined();
    expect(leaderConfig!.workspace).toBe(expectedLeaderWorkspace);

    // Step 6: verify the workspace path in config matches where files were written
    const configWorkspace = leaderConfig!.workspace as string;
    for (const file of files) {
      const filePath = path.join(configWorkspace, file);
      const content = await readFile(filePath, 'utf8');
      expect(content.length, `${file} should be readable from config workspace`).toBeGreaterThan(0);
    }
  });

  it('role agent workspace config matches actual file locations', async () => {
    const packageResult = await new TeamSkillPackageService().validate(fixturePath);
    if (!packageResult.package) {
      throw new Error('fixture package did not validate');
    }

    const provisioningService = new TeamProvisioningService({ storageRoot });
    const provisioned = await provisioningService.provisionRoleAgents({
      runtimeRoot,
      runId: 'run-e2e',
      teamSkillPackage: packageResult.package,
    });

    // Verify each role agent's workspace config matches actual file location
    for (const role of provisioned.roles) {
      const roleProjection = provisioned.managedConfigProjection.agents.find(
        (agent) => agent.id === role.agentId,
      );
      expect(roleProjection).toBeDefined();

      const expectedWorkspace = path.join(runtimeRoot, 'roles', role.roleId);
      expect(roleProjection!.workspace).toBe(expectedWorkspace);

      // Verify AGENTS.md exists in the role workspace
      const agentsMdPath = path.join(expectedWorkspace, 'AGENTS.md');
      const content = await readFile(agentsMdPath, 'utf8');
      expect(content.length, `AGENTS.md for role ${role.roleId} should not be empty`).toBeGreaterThan(0);
    }
  });
});
