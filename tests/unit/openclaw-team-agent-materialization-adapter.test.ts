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
  readonly exists?: ReturnType<typeof vi.fn>;
  readonly ensureDirectory?: ReturnType<typeof vi.fn>;
  readonly readTextFile?: ReturnType<typeof vi.fn>;
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
  const exists = options.exists ?? vi.fn(async () => false);
  const ensureDirectory = options.ensureDirectory ?? vi.fn(async () => undefined);
  const readTextFile = options.readTextFile ?? vi.fn(async () => '');
  const writeTextFile = options.writeTextFile ?? vi.fn(async () => undefined);
  const removeFile = options.removeFile ?? vi.fn(async () => undefined);
  const removeDirectory = options.removeDirectory ?? vi.fn(async () => undefined);
  return {
    adapter: new OpenClawTeamAgentMaterializationAdapter({
      gateway: { gatewayRpc },
      capabilities: { requirePluginMethod },
      fileSystem: { exists, ensureDirectory, readTextFile, writeTextFile, removeFile, removeDirectory },
      openClawConfigDir: '/openclaw',
      logger: options.logger,
    }),
    gatewayRpc,
    requirePluginMethod,
    exists,
    ensureDirectory,
    readTextFile,
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
      sourceType: 'teamskill',
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
        skills: ['team-leader-skill'],
        model: 'claude-sonnet-4-5',
      },
      roles: [
        {
          roleId: 'operator-designer',
          agentName: 'Operator Designer',
          roleMarkdown: '# operator\n\n## Duties\nDo work.\n\n## Inline Persona for Teammate\n\n```\nINLINE PERSONA\n```\n\n## Output\nReturn result.',
          skills: ['design'],
          tools: ['read'],
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
                deny: ['sessions_spawn', 'sessions_yield', 'subagents'],
              },
              sandbox: { mode: 'off' },
              model: 'claude-sonnet-4-5',
              skills: ['team-leader-skill'],
            },
            {
              id: operatorAgentId,
              name: 'Operator Designer',
              workspace: operatorWorkspacePath,
              tools: {
                profile: 'full',
                alsoAllow: ['read'],
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
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('## 工作模式'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('个人模式'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('团队模式'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('TeamRun 状态源是 runtime-host'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('TeamRun 工具门槛'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('不要用用户短语判定模式'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('## Team role 分派决策'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('触发场景：当前 prompt 表明你正在处理 TeamRun 中的 leader/coordinator node'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('把分派写入当前 node 的 NodeResult：result.assignments 使用 Role roster 里的 roleId'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('team_node_event complete 提交当前 node result'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('不用 team_graph_patch 承载一次性分派内容'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('正例：用户说“并行派发给四个角色” -> team_graph_context current_node -> team_node_event complete'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('反例：用户说“并行派发给四个角色” -> agents_list -> sessions_spawn 创建四个子智能体。这个路径违反 TeamRun。'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('等上一个 read 返回后再读下一个'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('OpenClaw read 工具参数字段是 path，不是 file_path'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining('- operator-designer'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'TOOLS.md'), expect.stringContaining('本地文件工具'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'TOOLS.md'), expect.stringContaining('参数字段是 path，不是 file_path'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'TOOLS.md'), expect.stringContaining('共同调用前检查'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'TOOLS.md'), expect.stringContaining('team_graph_context'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'TOOLS.md'), expect.stringContaining('team_graph_patch'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'AGENTS.md'), expect.stringContaining('## TeamRun 模式'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'AGENTS.md'), expect.stringContaining('runtimeKind/runtimeAdapterId/runtimeInstanceId 等顶层字段'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('正确参数片段'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('"runtimeKind": "native-runtime"'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('"runtimeAdapterId": "openclaw"'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('共同调用前检查'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('team_graph_context'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('team_node_event'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('顶层 summary。result.summary 不能替代顶层 summary'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('complete / reject 返回 success=true 后，停止对这个 nodeExecutionId 调用 team_node_event'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('不要使用 { "kind": "file" }'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('如果错误提到 runtimeKind 或 endpoint 字段'));
    expect(writeTextFile).toHaveBeenCalledWith(path.join(operatorWorkspacePath, 'TOOLS.md'), expect.stringContaining('不要改用 team_node_event 汇报这个失败'));
    expect(writeTextFile).not.toHaveBeenCalledWith(path.join(leaderWorkspacePath, 'AGENTS.md'), expect.stringContaining(operatorAgentId));
    for (const [, content] of writeTextFile.mock.calls.filter(([filePath]) => String(filePath).endsWith('AGENTS.md') || String(filePath).endsWith('TOOLS.md'))) {
      expect(content).not.toContain('legacy Team');
      expect(content).not.toContain('runtimeEndpoint');
      expect(content).not.toContain('真实 runId');
    }
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
      expect.stringContaining('# operator\n\n## Duties\nDo work.\n\n## Output\nReturn result.\n\n## TeamRun 模式'),
    );
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
      sourceType: 'teamskill',
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
      },
      roles: [
        {
          roleId: 'operator-designer',
          agentName: 'Operator Designer',
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
    const configSetCall = gatewayRpc.mock.calls.find(([method]) => method === 'config.set');
    const configSetPayload = configSetCall?.[1] as { raw?: string } | undefined;
    const writtenConfig = JSON.parse(configSetPayload?.raw ?? '{}') as { agents?: { defaults?: Record<string, unknown>; list?: Array<Record<string, unknown>> } };
    expect(writtenConfig.agents?.defaults).toBeUndefined();
    expect(writtenConfig.agents?.list?.some((entry) => Object.hasOwn(entry, 'skipBootstrap'))).toBe(false);
    expect(writtenConfig.agents?.list?.some((entry) => Object.hasOwn(entry, 'subagents'))).toBe(false);
    expect(gatewayRpc).toHaveBeenCalledWith('config.set', expect.objectContaining({
      raw: expect.stringContaining('"deny":["sessions_spawn","sessions_yield","subagents"]'),
      baseHash: 'existing-config-hash',
    }), 60000);
    expect(writeTextFile).toHaveBeenCalled();
    expect(result.managedAgents.map((agent) => agent.agentId)).toEqual([leaderAgentId, operatorAgentId]);
  });

  it('projects manual Team roles into selected source agent workspaces without owning their lifecycle', async () => {
    const leaderWorkspacePath = '/agents/existing-leader';
    const operatorWorkspacePath = '/agents/existing-operator';
    const leaderAgentsPath = path.join(leaderWorkspacePath, 'AGENTS.md');
    const leaderToolsPath = path.join(leaderWorkspacePath, 'TOOLS.md');
    const operatorAgentsPath = path.join(operatorWorkspacePath, 'AGENTS.md');
    const operatorToolsPath = path.join(operatorWorkspacePath, 'TOOLS.md');
    const originalLeaderConfig = {
      id: 'existing-leader-agent',
      name: 'Original Leader',
      workspace: leaderWorkspacePath,
      tools: { profile: 'limited' },
      sandbox: { mode: 'project' },
      model: 'claude-opus-4-1',
      skills: ['leader-existing-skill'],
      skipBootstrap: true,
      subagents: [{ id: 'leader-existing-helper' }],
    };
    const originalOperatorConfig = {
      id: 'existing-operator-agent',
      name: 'Original Operator',
      workspace: operatorWorkspacePath,
      tools: { alsoAllow: ['read'] },
      sandbox: { mode: 'project' },
      skills: ['operator-existing-skill'],
      skipBootstrap: true,
      subagents: [{ id: 'operator-existing-helper' }],
    };
    const existingFileContents = new Map<string, string>([
      [leaderAgentsPath, '# Existing Leader\n\nKeep leader rules.\n\n<!-- matchaclaw:begin -->\nGenerated leader context.\n<!-- matchaclaw:end -->\n'],
      [leaderToolsPath, '# Existing Leader Tools\n'],
      [operatorAgentsPath, '# Existing Operator\n'],
      [operatorToolsPath, '# Existing Operator Tools\n'],
    ]);
    const gatewayRpc = vi.fn(async (method: string) => {
      if (method === 'agents.list') {
        return {
          agents: [
            { id: 'existing-leader-agent', workspace: leaderWorkspacePath },
            { id: 'existing-operator-agent', workspace: operatorWorkspacePath },
          ],
        };
      }
      if (method === 'agents.create' || method === 'agents.update') {
        throw new Error(`${method} should not be called for manual source agents`);
      }
      if (method === 'config.get') {
        return { config: { agents: { list: [originalLeaderConfig, originalOperatorConfig] } }, hash: 'manual-config-hash' };
      }
      return { ok: true };
    });
    const exists = vi.fn(async (filePath: string) => existingFileContents.has(filePath));
    const readTextFile = vi.fn(async (filePath: string) => existingFileContents.get(filePath) ?? '');
    const { adapter, requirePluginMethod, ensureDirectory, writeTextFile, removeFile, removeDirectory } = createAdapter({ gatewayRpc, exists, readTextFile });

    const result = await adapter.materialize({
      teamId: 'manual-team',
      endpoint,
      sourceType: 'manual',
      teamSkill: {
        name: 'manual-team',
        skillMarkdown: '# manual skill',
        workflowMarkdown: '# manual workflow',
        dependenciesYaml: 'skills: []\ntools: []\n',
        dependencies: { skills: [], tools: [] },
      },
      leader: {
        roleId: 'leader',
        agentName: 'Existing Leader',
        sourceAgentId: 'existing-leader-agent',
        sourceWorkspace: leaderWorkspacePath,
      },
      roles: [
        {
          roleId: 'operator',
          agentName: 'Existing Operator',
          roleMarkdown: '# operator',
          sourceAgentId: 'existing-operator-agent',
          sourceWorkspace: operatorWorkspacePath,
        },
      ],
    });

    const writtenContentFor = (filePath: string): string => {
      const call = writeTextFile.mock.calls.find(([writtenFilePath]) => writtenFilePath === filePath);
      expect(call).toBeDefined();
      return String(call?.[1]);
    };
    const markerStart = '<!-- matchaclaw-teamrun:start:manual-team -->';
    const markerEnd = '<!-- matchaclaw-teamrun:end:manual-team -->';
    const leaderAgentsContent = writtenContentFor(leaderAgentsPath);
    const leaderToolsContent = writtenContentFor(leaderToolsPath);
    const operatorAgentsContent = writtenContentFor(operatorAgentsPath);
    const operatorToolsContent = writtenContentFor(operatorToolsPath);

    expect(requirePluginMethod).not.toHaveBeenCalledWith(expect.anything(), 'agents.create', expect.anything());
    expect(requirePluginMethod).not.toHaveBeenCalledWith(expect.anything(), 'agents.update', expect.anything());
    expect(gatewayRpc).not.toHaveBeenCalledWith('agents.create', expect.anything(), expect.anything());
    expect(gatewayRpc).not.toHaveBeenCalledWith('agents.update', expect.anything(), expect.anything());
    expect(leaderAgentsContent).toContain('# Existing Leader');
    expect(leaderAgentsContent).toContain(markerStart);
    expect(leaderAgentsContent).toContain('# TeamRun Leader Mode');
    expect(leaderAgentsContent).toContain('Team name: manual-team');
    expect(leaderAgentsContent).toContain(markerEnd);
    expect(leaderAgentsContent.indexOf(markerStart)).toBeLessThan(leaderAgentsContent.indexOf('<!-- matchaclaw:begin -->'));
    expect(leaderAgentsContent).toContain('Generated leader context.');
    expect(leaderToolsContent).toContain('# Existing Leader Tools');
    expect(leaderToolsContent).toContain(markerStart);
    expect(leaderToolsContent).toContain('这些工具只走 runtime-host TeamRun command/context 契约。');
    expect(leaderToolsContent).toContain(markerEnd);
    expect(operatorAgentsContent).toContain('# Existing Operator');
    expect(operatorAgentsContent).toContain(markerStart);
    expect(operatorAgentsContent).toContain('默认按当前 Agent 原有职责工作');
    expect(operatorAgentsContent).toContain(markerEnd);
    expect(operatorToolsContent).toContain('# Existing Operator Tools');
    expect(operatorToolsContent).toContain(markerStart);
    expect(operatorToolsContent).toContain('这些工具只用于 runtime-host TeamRun。');
    expect(operatorToolsContent).toContain(markerEnd);
    expect(ensureDirectory).not.toHaveBeenCalledWith(expect.stringContaining(path.join('/openclaw', 'teambuddy', 'manual-team')));
    expect(writeTextFile).not.toHaveBeenCalledWith(expect.stringContaining(path.join('/openclaw', 'teambuddy', 'manual-team')), expect.anything());
    expect(removeFile).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
    const configSetCall = gatewayRpc.mock.calls.find(([method]) => method === 'config.set');
    const configSetPayload = configSetCall?.[1] as { raw?: string } | undefined;
    const writtenConfig = JSON.parse(configSetPayload?.raw ?? '{}') as { agents?: { list?: Array<Record<string, unknown>> } };
    const writtenLeaderConfig = writtenConfig.agents?.list?.find((entry) => entry.id === 'existing-leader-agent');
    const writtenOperatorConfig = writtenConfig.agents?.list?.find((entry) => entry.id === 'existing-operator-agent');
    expect(writtenLeaderConfig).toMatchObject({
      name: originalLeaderConfig.name,
      workspace: originalLeaderConfig.workspace,
      model: originalLeaderConfig.model,
      skills: originalLeaderConfig.skills,
      skipBootstrap: true,
      subagents: originalLeaderConfig.subagents,
    });
    expect(writtenOperatorConfig).toMatchObject({
      name: originalOperatorConfig.name,
      workspace: originalOperatorConfig.workspace,
      skills: originalOperatorConfig.skills,
      skipBootstrap: true,
      subagents: originalOperatorConfig.subagents,
    });
    expect(Object.hasOwn(writtenOperatorConfig ?? {}, 'model')).toBe(false);
    expect(result.managedAgents).toEqual([
      {
        teamId: 'manual-team',
        roleId: 'leader',
        agentId: 'existing-leader-agent',
        displayName: 'Existing Leader',
        workspace: leaderWorkspacePath,
        endpoint,
        lifecycle: 'external',
        configRestore: {
          entryExisted: true,
          entry: originalLeaderConfig,
        },
      },
      {
        teamId: 'manual-team',
        roleId: 'operator',
        agentId: 'existing-operator-agent',
        displayName: 'Existing Operator',
        workspace: operatorWorkspacePath,
        endpoint,
        lifecycle: 'external',
        configRestore: {
          entryExisted: true,
          entry: originalOperatorConfig,
        },
      },
    ]);
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
      sourceType: 'teamskill',
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
      sourceType: 'teamskill',
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
      sourceType: 'teamskill',
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
      sourceType: 'teamskill',
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
      },
      roles: [{
        roleId: 'risk-analyst',
        agentName: 'Risk Analyst',
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
      sourceType: 'teamskill',
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
      sourceType: 'teamskill',
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
      },
      roles: [],
    })).rejects.toThrow('OpenClaw agents.create returned unexpected agentId for Team role leader: foreign-agent');
  });

  it('removes external TeamRun projection blocks and restores OpenClaw config without deleting selected agents', async () => {
    const leaderAgentsPath = path.join('/agents/external-leader', 'AGENTS.md');
    const leaderToolsPath = path.join('/agents/external-leader', 'TOOLS.md');
    const operatorAgentsPath = path.join('/agents/external-operator', 'AGENTS.md');
    const operatorToolsPath = path.join('/agents/external-operator', 'TOOLS.md');
    const configEntryBeforeTeamRun = {
      id: 'external-leader-agent',
      name: 'Original Leader',
      workspace: '/agents/external-leader',
      tools: { profile: 'limited' },
    };
    const existingFileContents = new Map<string, string>([
      [leaderAgentsPath, '# Leader\n\n<!-- matchaclaw-teamrun:start:manual-team -->\nTeamRun leader block\n<!-- matchaclaw-teamrun:end:manual-team -->\n\nKeep leader footer.\n'],
      [leaderToolsPath, '# Leader Tools\n\n<!-- matchaclaw-teamrun:start:manual-team -->\nTeamRun tools block\n<!-- matchaclaw-teamrun:end:manual-team -->\n'],
      [operatorAgentsPath, '# Operator\n\n<!-- matchaclaw-teamrun:start:manual-team -->\nTeamRun operator block\n<!-- matchaclaw-teamrun:end:manual-team -->\n'],
      [operatorToolsPath, '# Operator Tools\n\n<!-- matchaclaw-teamrun:start:manual-team -->\nTeamRun operator tools block\n<!-- matchaclaw-teamrun:end:manual-team -->\n'],
    ]);
    const gatewayRpc = vi.fn(async (method: string) => {
      if (method === 'agents.delete') {
        throw new Error('agents.delete should not be called for external TeamRun agents');
      }
      if (method === 'config.get') {
        return {
          config: {
            agents: {
              list: [
                {
                  id: 'external-leader-agent',
                  name: 'TeamRun Leader',
                  workspace: '/agents/external-leader',
                  tools: { profile: 'full' },
                },
                {
                  id: 'external-operator-agent',
                  name: 'TeamRun Operator',
                  workspace: '/agents/external-operator',
                  tools: { profile: 'full' },
                },
              ],
            },
          },
          hash: 'external-remove-config-hash',
        };
      }
      return { ok: true };
    });
    const exists = vi.fn(async (filePath: string) => existingFileContents.has(filePath));
    const readTextFile = vi.fn(async (filePath: string) => existingFileContents.get(filePath) ?? '');
    const { adapter, gatewayRpc: gatewayRpcMock, writeTextFile, removeDirectory } = createAdapter({ gatewayRpc, exists, readTextFile });

    await adapter.removeTeamAgents({
      teamId: 'manual-team',
      endpoint,
      managedAgents: [
        {
          teamId: 'manual-team',
          roleId: 'leader',
          agentId: 'external-leader-agent',
          displayName: 'External Leader',
          workspace: '/agents/external-leader',
          endpoint,
          lifecycle: 'external',
          configRestore: {
            entryExisted: true,
            entry: configEntryBeforeTeamRun,
          },
        },
        {
          teamId: 'manual-team',
          roleId: 'operator',
          agentId: 'external-operator-agent',
          displayName: 'External Operator',
          workspace: '/agents/external-operator',
          endpoint,
          lifecycle: 'external',
          configRestore: { entryExisted: false },
        },
      ],
    });

    for (const filePath of [leaderAgentsPath, leaderToolsPath, operatorAgentsPath, operatorToolsPath]) {
      const writeCall = writeTextFile.mock.calls.find(([writtenFilePath]) => writtenFilePath === filePath);
      expect(writeCall).toBeDefined();
      expect(String(writeCall?.[1])).not.toContain('matchaclaw-teamrun:start:manual-team');
      expect(String(writeCall?.[1])).not.toContain('matchaclaw-teamrun:end:manual-team');
    }
    expect(String(writeTextFile.mock.calls.find(([filePath]) => filePath === leaderAgentsPath)?.[1])).toContain('Keep leader footer.');
    expect(gatewayRpcMock).not.toHaveBeenCalledWith('agents.delete', expect.anything(), expect.anything());
    const configSetCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'config.set');
    const configSetPayload = configSetCall?.[1] as { raw?: string; baseHash?: string } | undefined;
    expect(configSetPayload?.baseHash).toBe('external-remove-config-hash');
    expect(JSON.parse(configSetPayload?.raw ?? '{}')).toEqual({
      agents: {
        list: [configEntryBeforeTeamRun],
      },
    });
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it('removes only team-managed agents through OpenClaw agents.delete', async () => {
    const { adapter, gatewayRpc } = createAdapter();
    const leaderAgentId = buildTeamManagedAgentId('team-remove-1', 'leader');
    const roleAgentId = buildTeamManagedAgentId('team-remove-1', 'operator-designer');

    await adapter.removeTeamAgents({
      teamId: 'team-remove-1',
      endpoint,
      managedAgents: [
        {
          teamId: 'team-remove-1',
          roleId: 'leader',
          agentId: leaderAgentId,
          displayName: 'Leader',
          workspace: path.join('/openclaw', 'teambuddy', 'remove-team'),
          endpoint,
          lifecycle: 'team-owned',
        },
        {
          teamId: 'team-remove-1',
          roleId: 'operator-designer',
          agentId: roleAgentId,
          displayName: 'Operator Designer',
          workspace: path.join('/openclaw', 'teambuddy', 'remove-team', 'roles', 'operator-designer'),
          endpoint,
          lifecycle: 'team-owned',
        },
      ],
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
    const outsideWorkspaceAgentId = buildTeamManagedAgentId('team-remove-workspace', 'outside');

    await adapter.removeTeamAgents({
      teamId: 'team-remove-workspace',
      endpoint,
      managedAgents: [
        {
          teamId: 'team-remove-workspace',
          roleId: 'leader',
          agentId: leaderAgentId,
          displayName: 'Leader',
          workspace: path.join('/openclaw', 'teambuddy', 'investment-due-diligence-team'),
          endpoint,
          lifecycle: 'team-owned',
        },
        {
          teamId: 'team-remove-workspace',
          roleId: 'operator-designer',
          agentId: roleAgentId,
          displayName: 'Operator Designer',
          workspace: path.join('/openclaw', 'teambuddy', 'investment-due-diligence-team', 'roles', 'operator-designer'),
          endpoint,
          lifecycle: 'team-owned',
        },
        {
          teamId: 'team-remove-workspace',
          roleId: 'outside',
          agentId: outsideWorkspaceAgentId,
          displayName: 'Outside',
          workspace: path.join('/openclaw', 'other', 'not-team-buddy'),
          endpoint,
          lifecycle: 'team-owned',
        },
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
      managedAgents: [
        {
          teamId: 'team-remove-missing',
          roleId: 'leader',
          agentId: leaderAgentId,
          displayName: 'Leader',
          workspace: path.join('/openclaw', 'teambuddy', 'missing-team'),
          endpoint,
          lifecycle: 'team-owned',
        },
        {
          teamId: 'team-remove-missing',
          roleId: 'operator-designer',
          agentId: roleAgentId,
          displayName: 'Operator Designer',
          workspace: path.join('/openclaw', 'teambuddy', 'missing-team', 'roles', 'operator-designer'),
          endpoint,
          lifecycle: 'team-owned',
        },
      ],
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
      managedAgents: [
        {
          teamId: 'team-remove-2',
          roleId: 'external',
          agentId: 'external-agent',
          displayName: 'External Agent',
          workspace: '/agents/external',
          endpoint,
          lifecycle: 'team-owned',
        },
      ],
    })).rejects.toThrow('Refusing to remove non-Team OpenClaw agent for team team-remove-2: external-agent');
    expect(gatewayRpc).not.toHaveBeenCalled();
  });
});
