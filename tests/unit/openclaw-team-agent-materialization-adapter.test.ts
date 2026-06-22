import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTeamManagedAgentId } from '../../runtime-host/application/team-runtime/domain/team-managed-agent';
import { OpenClawTeamAgentMaterializationAdapter } from '../../runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-agent-materialization-adapter';
import type { GatewayPluginCapabilityDefinition } from '../../runtime-host/application/gateway/gateway-capability-service';
import type { RuntimeEndpointRef } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';

const endpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

function createAdapter(options: {
  readonly gatewayRpc?: ReturnType<typeof vi.fn>;
  readonly requirePluginMethod?: ReturnType<typeof vi.fn>;
  readonly ensureDirectory?: ReturnType<typeof vi.fn>;
  readonly writeTextFile?: ReturnType<typeof vi.fn>;
  readonly removeFile?: ReturnType<typeof vi.fn>;
  readonly removeDirectory?: ReturnType<typeof vi.fn>;
  readonly logger?: { readonly debug: ReturnType<typeof vi.fn>; readonly error?: ReturnType<typeof vi.fn> };
} = {}) {
  const gatewayRpc = options.gatewayRpc ?? vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'agents.list') {
      return { agents: [] };
    }
    if (method === 'agents.create') {
      return { agentId: params.name };
    }
    if (method === 'config.get') {
      return { config: { agents: { list: [] } }, hash: 'config-hash-1' };
    }
    return { ok: true };
  });
  const requirePluginMethod = options.requirePluginMethod ?? vi.fn(async () => null);
  const ensureDirectory = options.ensureDirectory ?? vi.fn(async () => undefined);
  const writeTextFile = options.writeTextFile ?? vi.fn(async () => undefined);
  const removeFile = options.removeFile ?? vi.fn(async () => undefined);
  const removeDirectory = options.removeDirectory ?? vi.fn(async () => undefined);
  return {
    adapter: new OpenClawTeamAgentMaterializationAdapter({
      gateway: { gatewayRpc },
      capabilities: { requirePluginMethod },
      fileSystem: { ensureDirectory, writeTextFile, removeFile, removeDirectory },
      openClawConfigDir: '/openclaw',
      logger: options.logger,
    }),
    gatewayRpc,
    requirePluginMethod,
    ensureDirectory,
    writeTextFile,
    removeFile,
    removeDirectory,
  };
}

describe('OpenClawTeamAgentMaterializationAdapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('materializes Team roles through OpenClaw agents/files RPC and returns stable session bindings', async () => {
    const { adapter, gatewayRpc, requirePluginMethod, writeTextFile, removeFile } = createAdapter();
    const result = await adapter.materialize({
      teamId: 'team-investment',
      runId: 'run-materialize-1',
      endpoint,
      teamSkill: {
        name: 'investment-due-diligence-team',
        skillMarkdown: '# skill',
        workflowMarkdown: '# workflow',
        dependenciesYaml: 'skills: []\ntools: []\n',
        dependencies: { skills: [], tools: [] },
        bindMarkdown: '# bind',
      },
      leader: {
        roleId: 'leader',
        agentName: 'Team Leader',
        workspacePath: '/runs/run-materialize-1/leader',
        agentDir: '/runs/run-materialize-1/managed/leader',
        files: [{ path: 'AGENTS.md', content: '# leader' }],
        skills: ['team-leader-skill'],
        tools: ['team_submit_workflow_plan'],
        model: 'claude-sonnet-4-5',
      },
      roles: [
        {
          roleId: 'operator-designer',
          agentName: 'Operator Designer',
          workspacePath: '/runs/run-materialize-1/roles/operator-designer',
          agentDir: '/runs/run-materialize-1/managed/operator-designer',
          files: [
            { path: 'operator-designer.md', content: '# operator\n\n## Duties\nDo work.\n\n## Inline Persona for Teammate\n\n```\nINLINE PERSONA\n```\n\n## Output\nReturn result.' },
            { path: 'workflow.md', content: 'do work' },
          ],
          skills: ['design'],
          tools: ['team_complete_task'],
        },
      ],
    });

    const leaderAgentId = buildTeamManagedAgentId('team-investment', 'leader');
    const operatorAgentId = buildTeamManagedAgentId('team-investment', 'operator-designer');
    const leaderWorkspacePath = path.join('/openclaw', 'teambuddy', 'investment-due-diligence-team');
    const operatorWorkspacePath = path.join(leaderWorkspacePath, 'roles', 'operator-designer');
    const teamSkillPackagePath = path.join(leaderWorkspacePath, 'skills', 'investment-due-diligence-team');

    expect(requirePluginMethod).toHaveBeenCalledWith(
      expect.objectContaining<Partial<GatewayPluginCapabilityDefinition>>({ pluginId: 'subagents' }),
      'agents.create',
      5000,
    );
    expect(gatewayRpc).toHaveBeenCalledWith('agents.create', {
      name: leaderAgentId,
      workspace: leaderWorkspacePath,
    }, 60000);
    expect(gatewayRpc).toHaveBeenCalledWith('agents.update', {
      agentId: leaderAgentId,
      name: 'Team Leader',
      workspace: leaderWorkspacePath,
      model: 'claude-sonnet-4-5',
    }, 60000);
    expect(gatewayRpc).toHaveBeenCalledWith('agents.create', {
      name: operatorAgentId,
      workspace: operatorWorkspacePath,
    }, 60000);
    expect(gatewayRpc).toHaveBeenCalledWith('agents.update', {
      agentId: operatorAgentId,
      name: 'Operator Designer',
      workspace: operatorWorkspacePath,
    }, 60000);
    expect(gatewayRpc).toHaveBeenCalledWith('config.set', {
      raw: JSON.stringify({
        agents: {
          list: [
            {
              id: leaderAgentId,
              name: 'Team Leader',
              workspace: leaderWorkspacePath,
              tools: {
                profile: 'full',
              },
              sandbox: { mode: 'off' },
              model: 'claude-sonnet-4-5',
              skills: ['team-leader-skill'],
              subagents: { allowAgents: [operatorAgentId], requireAgentId: true },
            },
            {
              id: operatorAgentId,
              name: 'Operator Designer',
              workspace: operatorWorkspacePath,
              tools: {
                profile: 'full',
                allow: ['team_complete_task', 'team_request_approval', 'team_send_message'],
                deny: ['sessions_spawn', 'sessions_yield', 'subagents'],
              },
              sandbox: { mode: 'off' },
              skills: ['design'],
            },
          ],
        },
      }),
      baseHash: 'config-hash-1',
    }, 60000);
    expect(gatewayRpc).not.toHaveBeenCalledWith('agents.files.set', expect.anything(), 60000);
    const agentUpdateCallOrders = gatewayRpc.mock.calls
      .map(([method], index) => method === 'agents.update' ? gatewayRpc.mock.invocationCallOrder[index] : undefined)
      .filter((callOrder): callOrder is number => callOrder !== undefined);
    expect(Math.min(...writeTextFile.mock.invocationCallOrder)).toBeGreaterThan(Math.max(...agentUpdateCallOrders));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('## 首次判断'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('顶层 groups 存在'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('不要一次并发读取多个 role 文件'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('- operator-designer'));
    expect(writeTextFile).not.toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining(operatorAgentId));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'TOOLS.md'), expect.stringContaining('## Team Submit Workflow Plan'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'TOOLS.md'), expect.stringContaining('不要只提交 tasks，也不要省略 title 或 groups'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'TOOLS.md'), expect.stringContaining('task.title 和 group.title 不能替代 workflow title'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'TOOLS.md'), expect.stringContaining('不要包含 runtime 字段，例如 runId'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(teamSkillPackagePath, 'SKILL.md'), '# skill');
    expect(writeTextFile).toHaveBeenCalledWith(path.join(teamSkillPackagePath, 'workflow.md'), '# workflow');
    expect(writeTextFile).toHaveBeenCalledWith(path.join(teamSkillPackagePath, 'bind.md'), '# bind');
    expect(writeTextFile).toHaveBeenCalledWith(path.join(teamSkillPackagePath, 'dependencies.yaml'), 'skills: []\ntools: []\n');
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'dependencies.json'), '{\n  "skills": [],\n  "tools": []\n}\n');
    expect(writeTextFile).toHaveBeenCalledWith(
      path.join(teamSkillPackagePath, 'roles', 'operator-designer.md'),
      '# operator\n\n## Duties\nDo work.\n\n## Inline Persona for Teammate\n\n```\nINLINE PERSONA\n```\n\n## Output\nReturn result.',
    );
    expect(writeTextFile).toHaveBeenCalledWith(
      path.join(operatorWorkspacePath, 'AGENTS.md'),
      '# operator\n\n## Duties\nDo work.\n\n## Output\nReturn result.',
    );
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('## Team Complete Task'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('inlineText.text 单条最多 20000 字符'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('不要调用 Team Submit Workflow Plan'));
    for (const generatedFileName of ['IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md']) {
      expect(removeFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, generatedFileName));
      expect(removeFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, generatedFileName));
    }

    expect(result).toEqual({
      teamId: 'team-investment',
      managedAgents: [
        {
          teamId: 'team-investment',
          roleId: 'leader',
          agentId: leaderAgentId,
          displayName: 'Team Leader',
          workspace: leaderWorkspacePath,
          endpoint,
          model: 'claude-sonnet-4-5',
        },
        {
          teamId: 'team-investment',
          roleId: 'operator-designer',
          agentId: operatorAgentId,
          displayName: 'Operator Designer',
          workspace: operatorWorkspacePath,
          endpoint,
        },
      ],
    });
  });

  it('updates existing Team agents during Team agent materialization without creating duplicates', async () => {
    const leaderAgentId = buildTeamManagedAgentId('team-existing-agents', 'leader');
    const operatorAgentId = buildTeamManagedAgentId('team-existing-agents', 'operator-designer');
    const gatewayRpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'agents.list') {
        return {
          agents: [
            { id: leaderAgentId, workspace: path.join('/openclaw', 'teambuddy', 'existing-agents-team') },
            { id: operatorAgentId, workspace: path.join('/openclaw', 'teambuddy', 'existing-agents-team', 'roles', 'operator-designer') },
          ],
        };
      }
      if (method === 'agents.create') {
        throw new Error(`agents.create should not be called for existing Team agent ${String(params.name)}`);
      }
      if (method === 'config.get') {
        return { config: { agents: { list: [
          { id: leaderAgentId, workspace: path.join('/openclaw', 'teambuddy', 'existing-agents-team'), skipBootstrap: true },
          { id: operatorAgentId, workspace: path.join('/openclaw', 'teambuddy', 'existing-agents-team', 'roles', 'operator-designer'), skipBootstrap: true },
        ] } }, hash: 'existing-config-hash' };
      }
      return { ok: true };
    });
    const writeTextFile = vi.fn(async () => undefined);
    const { adapter } = createAdapter({ gatewayRpc, writeTextFile });

    const result = await adapter.materialize({
      teamId: 'team-existing-agents',
      runId: 'run-existing-agents-2',
      endpoint,
      teamSkill: {
        name: 'existing-agents-team',
        skillMarkdown: '# skill',
        workflowMarkdown: '# workflow',
        dependenciesYaml: 'skills: []\ntools: []\n',
        dependencies: { skills: [], tools: [] },
      },
      leader: {
        roleId: 'leader',
        agentName: 'Leader',
        workspacePath: '/runs/run-existing-agents-2/leader',
        files: [],
      },
      roles: [
        {
          roleId: 'operator-designer',
          agentName: 'Operator Designer',
          workspacePath: '/runs/run-existing-agents-2/roles/operator-designer',
          files: [],
        },
      ],
    });

    expect(gatewayRpc).not.toHaveBeenCalledWith('agents.create', expect.anything(), expect.anything());
    expect(gatewayRpc).toHaveBeenCalledWith('agents.update', expect.objectContaining({
      agentId: leaderAgentId,
    }), 60000);
    expect(gatewayRpc).toHaveBeenCalledWith('agents.update', expect.objectContaining({
      agentId: operatorAgentId,
    }), 60000);
    expect(gatewayRpc).toHaveBeenCalledWith('config.set', expect.objectContaining({
      raw: expect.stringContaining('"subagents":{"allowAgents"'),
      baseHash: 'existing-config-hash',
    }), 60000);
    const configSetCall = gatewayRpc.mock.calls.find(([method]) => method === 'config.set');
    const configSetPayload = configSetCall?.[1] as { raw?: string } | undefined;
    const writtenConfig = JSON.parse(configSetPayload?.raw ?? '{}') as { agents?: { defaults?: Record<string, unknown>; list?: Array<Record<string, unknown>> } };
    expect(writtenConfig.agents?.defaults).toBeUndefined();
    expect(writtenConfig.agents?.list?.some((entry) => Object.hasOwn(entry, 'skipBootstrap'))).toBe(false);
    expect(gatewayRpc).toHaveBeenCalledWith('config.set', expect.objectContaining({
      raw: expect.stringContaining('"deny":["sessions_spawn","sessions_yield","subagents"]'),
      baseHash: 'existing-config-hash',
    }), 60000);
    expect(writeTextFile).toHaveBeenCalled();
    expect(result.managedAgents.map((agent) => agent.agentId)).toEqual([leaderAgentId, operatorAgentId]);
  });

  it('rejects existing deterministic Team agent ids outside the TeamBuddy workspace', async () => {
    const leaderAgentId = buildTeamManagedAgentId('team-agent-collision', 'leader');
    const { adapter } = createAdapter({
      gatewayRpc: vi.fn(async (method: string) => method === 'agents.list'
        ? { agents: [{ id: leaderAgentId, workspace: '/user/agents/leader' }] }
        : { ok: true }),
    });

    await expect(adapter.materialize({
      teamId: 'team-agent-collision',
      runId: 'run-agent-collision',
      endpoint,
      teamSkill: {
        name: 'collision-team',
        skillMarkdown: '# skill',
        workflowMarkdown: '# workflow',
        dependenciesYaml: 'skills: []\ntools: []\n',
        dependencies: { skills: [], tools: [] },
      },
      leader: {
        roleId: 'leader',
        agentName: 'Leader',
        workspacePath: '/runs/run-agent-collision/leader',
        files: [],
      },
      roles: [],
    })).rejects.toThrow(`Team managed agent id collides with non-Team OpenClaw agent: ${leaderAgentId}`);
  });

  it('logs safe materialization error context when OpenClaw agent creation fails', async () => {
    vi.stubEnv('MATCHACLAW_TEAM_RUNTIME_DEBUG', '1');
    const logger = { debug: vi.fn(), error: vi.fn() };
    const { adapter, writeTextFile } = createAdapter({
      logger,
      gatewayRpc: vi.fn(async (method: string) => {
        if (method === 'agents.list') {
          return { agents: [] };
        }
        if (method === 'agents.create') {
          throw new Error('agents.create failed token=secret-token-value sk-live-secret-value');
        }
        return { ok: true };
      }),
    });

    await expect(adapter.materialize({
      teamId: 'team-logged-error',
      runId: 'run-logged-error',
      endpoint,
      teamSkill: {
        name: 'logged-error-team',
        skillMarkdown: '# skill with prompt secret',
        workflowMarkdown: '# workflow with prompt secret',
        dependenciesYaml: 'skills: []\ntools: []\n',
        dependencies: { skills: [], tools: [] },
      },
      leader: {
        roleId: 'leader',
        agentName: 'Leader',
        workspacePath: '/runs/run-logged-error/leader',
        files: [{ path: 'AGENTS.md', content: '# secret agent prompt' }],
      },
      roles: [],
    })).rejects.toThrow('agents.create failed');

    const errorMessages = logger.error.mock.calls.map(([message]) => String(message));
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(errorMessages.some((message) => message.includes('stage="agent.create.error"'))).toBe(true);
    expect(errorMessages.some((message) => message.includes('teamId="team-logged-error"'))).toBe(true);
    expect(errorMessages.join('\n')).not.toContain('secret-token-value');
    expect(errorMessages.join('\n')).not.toContain('sk-live-secret-value');
    expect(errorMessages.join('\n')).not.toContain('# secret agent prompt');
  });

  it('does not write TeamBuddy projection files when OpenClaw agent update fails', async () => {
    const { adapter, writeTextFile } = createAdapter({
      gatewayRpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === 'agents.list') {
          return { agents: [] };
        }
        if (method === 'agents.create') {
          return { agentId: params.name };
        }
        if (method === 'agents.update') {
          throw new Error('agents.update failed');
        }
        return { ok: true };
      }),
    });

    await expect(adapter.materialize({
      teamId: 'team-update-fails',
      runId: 'run-update-fails',
      endpoint,
      teamSkill: {
        name: 'update-fails-team',
        skillMarkdown: '# skill',
        workflowMarkdown: '# workflow',
        dependenciesYaml: 'skills: []\ntools: []\n',
        dependencies: { skills: [], tools: [] },
      },
      leader: {
        roleId: 'leader',
        agentName: 'Leader',
        workspacePath: '/runs/run-update-fails/leader',
        files: [],
      },
      roles: [],
    })).rejects.toThrow('agents.update failed');

    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('does not redact sk inside regular role ids in materialization logs', async () => {
    vi.stubEnv('MATCHACLAW_TEAM_RUNTIME_DEBUG', '1');
    const logger = { debug: vi.fn(), error: vi.fn() };
    const { adapter } = createAdapter({ logger });

    await adapter.materialize({
      teamId: 'team-risk-logging',
      runId: 'run-risk-logging',
      endpoint,
      teamSkill: {
        name: 'risk-team',
        skillMarkdown: '# skill',
        workflowMarkdown: '# workflow',
        dependenciesYaml: 'skills: []\ntools: []\n',
        dependencies: { skills: [], tools: [] },
      },
      leader: {
        roleId: 'leader',
        agentName: 'Leader',
        workspacePath: '/runs/run-risk-logging/leader',
        files: [],
      },
      roles: [{
        roleId: 'risk-analyst',
        agentName: 'Risk Analyst',
        workspacePath: '/runs/run-risk-logging/risk-analyst',
        files: [],
      }],
    });

    const debugMessages = logger.debug.mock.calls.map(([message]) => String(message)).join('\n');
    expect(debugMessages).toContain('risk-analyst');
    expect(debugMessages).not.toContain('ri[redacted-secret]');
  });

  it('rejects missing or unexpected created agent identity instead of returning a wrong binding', async () => {
    const missingAgentId = createAdapter({
      gatewayRpc: vi.fn(async (method: string) => method === 'agents.create' ? {} : method === 'agents.list' ? { agents: [] } : {}),
    });
    await expect(missingAgentId.adapter.materialize({
      teamId: 'team-missing-agent',
      runId: 'run-missing-agent',
      endpoint,
      teamSkill: {
        name: 'missing-agent-team',
        skillMarkdown: '# skill',
        workflowMarkdown: '# workflow',
        dependenciesYaml: 'skills: []\ntools: []\n',
        dependencies: { skills: [], tools: [] },
      },
      leader: {
        roleId: 'leader',
        agentName: 'Leader',
        workspacePath: '/runs/run-missing-agent/leader',
        files: [],
      },
      roles: [],
    })).rejects.toThrow('OpenClaw agents.create did not confirm agentId for Team role leader');

    const unexpectedAgentId = createAdapter({
      gatewayRpc: vi.fn(async (method: string) => method === 'agents.create' ? { agentId: 'foreign-agent' } : method === 'agents.list' ? { agents: [] } : {}),
    });
    await expect(unexpectedAgentId.adapter.materialize({
      teamId: 'team-wrong-agent',
      runId: 'run-wrong-agent',
      endpoint,
      teamSkill: {
        name: 'wrong-agent-team',
        skillMarkdown: '# skill',
        workflowMarkdown: '# workflow',
        dependenciesYaml: 'skills: []\ntools: []\n',
        dependencies: { skills: [], tools: [] },
      },
      leader: {
        roleId: 'leader',
        agentName: 'Leader',
        workspacePath: '/runs/run-wrong-agent/leader',
        files: [],
      },
      roles: [],
    })).rejects.toThrow('OpenClaw agents.create returned unexpected agentId for Team role leader: foreign-agent');
  });

  it('removes only team-managed agents through OpenClaw agents.delete', async () => {
    const { adapter, gatewayRpc } = createAdapter();
    const leaderAgentId = buildTeamManagedAgentId('team-remove-1', 'leader');
    const roleAgentId = buildTeamManagedAgentId('team-remove-1', 'operator-designer');

    await adapter.removeTeamAgents({
      teamId: 'team-remove-1',
      endpoint,
      agentIds: [leaderAgentId, roleAgentId],
    });

    expect(gatewayRpc).toHaveBeenNthCalledWith(1, 'agents.delete', {
      agentId: leaderAgentId,
      deleteFiles: true,
    }, 60000);
    expect(gatewayRpc).toHaveBeenNthCalledWith(2, 'agents.delete', {
      agentId: roleAgentId,
      deleteFiles: true,
    }, 60000);
  });

  it('removes top-level TeamBuddy workspace directories after deleting managed agents', async () => {
    const { adapter, removeDirectory } = createAdapter();
    const leaderAgentId = buildTeamManagedAgentId('team-remove-workspace', 'leader');
    const roleAgentId = buildTeamManagedAgentId('team-remove-workspace', 'operator-designer');

    await adapter.removeTeamAgents({
      teamId: 'team-remove-workspace',
      endpoint,
      agentIds: [leaderAgentId, roleAgentId],
      workspacePaths: [
        path.join('/openclaw', 'teambuddy', 'investment-due-diligence-team'),
        path.join('/openclaw', 'teambuddy', 'investment-due-diligence-team', 'roles', 'operator-designer'),
        path.join('/openclaw', 'other', 'not-team-buddy'),
      ],
    });

    expect(removeDirectory).toHaveBeenCalledTimes(1);
    expect(removeDirectory).toHaveBeenCalledWith(path.resolve('/openclaw', 'teambuddy', 'investment-due-diligence-team'));
  });

  it('continues deleting Team agents when one managed agent is already missing', async () => {
    const leaderAgentId = buildTeamManagedAgentId('team-remove-missing', 'leader');
    const roleAgentId = buildTeamManagedAgentId('team-remove-missing', 'operator-designer');
    const gatewayRpc = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if (params.agentId === leaderAgentId) {
        throw new Error(`agent "${leaderAgentId}" not found`);
      }
      return { ok: true };
    });
    const { adapter } = createAdapter({ gatewayRpc });

    await expect(adapter.removeTeamAgents({
      teamId: 'team-remove-missing',
      endpoint,
      agentIds: [leaderAgentId, roleAgentId],
    })).resolves.toBeUndefined();

    expect(gatewayRpc).toHaveBeenCalledWith('agents.delete', {
      agentId: leaderAgentId,
      deleteFiles: true,
    }, 60000);
    expect(gatewayRpc).toHaveBeenCalledWith('agents.delete', {
      agentId: roleAgentId,
      deleteFiles: true,
    }, 60000);
  });

  it('refuses to remove agent ids outside the Team ownership prefix', async () => {
    const { adapter, gatewayRpc } = createAdapter();

    await expect(adapter.removeTeamAgents({
      teamId: 'team-remove-2',
      endpoint,
      agentIds: ['external-agent'],
    })).rejects.toThrow('Refusing to remove non-Team OpenClaw agent for team team-remove-2: external-agent');
    expect(gatewayRpc).not.toHaveBeenCalled();
  });
});
