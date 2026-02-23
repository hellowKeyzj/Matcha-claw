import { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';

export const TEAM_CONTROLLER_ID = 'team-controller';
export const TEAM_CONTROLLER_NAME = 'team-controller';
export const TEAM_CONTROLLER_EMOJI = '\uD83E\uDDED';
export const TEAM_CONTROLLER_PROMPT_STORAGE_KEY = 'clawx.teamControllerPromptTemplate';

export const DEFAULT_TEAM_CONTROLLER_PROMPT = [
  '# 角色',
  '你是多 Agent 团队的主控（Controller），你的核心职责跨团队保持一致：',
  '1) 澄清目标、范围、约束、验收标准。',
  '2) 提出协作方案与成员分工，并要求用户确认。',
  '3) 控制阶段流转：讨论 -> 收敛 -> 执行 -> 完成。',
  '4) 将任务拆解并分配给成员。',
  '5) 收集成员 REPORT，校验是否满足验收标准。',
  '6) 维护共享上下文（进度、决策、风险、下一步）。',
  '7) 处理异常（成员失败、报告缺失、冲突决策）。',
  '8) 输出最终交付结论，可选沉淀 workflow/skill。',
  '',
  '# 你应具备的能力',
  '- 任务分解与优先级管理',
  '- 多角色协作编排',
  '- 结构化输入输出约束（PLAN/REPORT）',
  '- 风险识别与回退策略',
  '- 汇总与决策',
  '',
  '# 禁止事项',
  '- 不要长时间亲自执行具体业务任务。',
  '- 不要代替子 Agent 产出全部细节实现。',
  '- 不要在缺少证据时宣称任务完成。',
  '',
  '# 阶段规则',
  '- discussion：允许发散讨论，收集信息，识别不确定项。',
  '- convergence：输出明确 PLAN，并给出分工与验收标准。',
  '- execution：跟踪成员 REPORT，仅以 done 结果更新共享进度。',
  '- done：输出最终结论、风险与后续建议。',
  '',
  '# 输出要求',
  '- 收敛阶段请输出 PLAN（结构化）。',
  '- 执行阶段请输出 TASKS（按 agent 分配）。',
  '- 总结阶段请输出 SUMMARY（已完成/未完成/风险/下一步）。',
  '- 若信息不足，先提出最小问题集，再继续推进。',
].join('\n');

type RpcResult<T> = { success: boolean; result?: T; error?: string };

interface AgentListResult {
  agents?: Array<{ id?: string }>;
}

interface AgentFileMeta {
  name?: string;
  missing?: boolean;
  size?: number;
}

interface AgentFilesListResult {
  files?: AgentFileMeta[];
}

interface AgentFileGetResult {
  file?: {
    content?: string;
  };
  content?: string;
}

export type TeamControllerReadiness = {
  ready: boolean;
  exists: boolean;
  missingFiles: string[];
  agentsMdNonEmpty: boolean;
  reason?: 'missing-agent' | 'missing-files' | 'agents-md-empty';
};

async function rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  const response = await window.electron.ipcRenderer.invoke('gateway:rpc', method, params, timeoutMs) as RpcResult<T>;
  if (!response.success) {
    throw new Error(response.error || `RPC failed: ${method}`);
  }
  return response.result as T;
}

function normalizeAgentFileContent(result: AgentFileGetResult): string {
  if (typeof result?.file?.content === 'string') {
    return result.file.content;
  }
  if (typeof result?.content === 'string') {
    return result.content;
  }
  return '';
}

export async function checkTeamControllerReadiness(agentId = TEAM_CONTROLLER_ID): Promise<TeamControllerReadiness> {
  const listed = await rpc<AgentListResult>('agents.list', {});
  const exists = Array.isArray(listed?.agents) && listed.agents.some((agent) => agent?.id === agentId);
  if (!exists) {
    return {
      ready: false,
      exists: false,
      missingFiles: [...SUBAGENT_TARGET_FILES],
      agentsMdNonEmpty: false,
      reason: 'missing-agent',
    };
  }

  const filesResult = await rpc<AgentFilesListResult>('agents.files.list', { agentId });
  const fileMetas = Array.isArray(filesResult?.files) ? filesResult.files : [];
  const byName = new Map(fileMetas.map((file) => [file?.name ?? '', file]));
  const missingFiles = SUBAGENT_TARGET_FILES.filter((name) => {
    const file = byName.get(name);
    return !file || file.missing === true;
  });

  if (missingFiles.length > 0) {
    return {
      ready: false,
      exists: true,
      missingFiles,
      agentsMdNonEmpty: false,
      reason: 'missing-files',
    };
  }

  const agentsMeta = byName.get('AGENTS.md');
  let agentsMdNonEmpty = typeof agentsMeta?.size === 'number' ? agentsMeta.size > 0 : false;
  if (!agentsMdNonEmpty) {
    const contentResult = await rpc<AgentFileGetResult>('agents.files.get', { agentId, name: 'AGENTS.md' });
    agentsMdNonEmpty = normalizeAgentFileContent(contentResult).trim().length > 0;
  }

  if (!agentsMdNonEmpty) {
    return {
      ready: false,
      exists: true,
      missingFiles: [],
      agentsMdNonEmpty: false,
      reason: 'agents-md-empty',
    };
  }

  return {
    ready: true,
    exists: true,
    missingFiles: [],
    agentsMdNonEmpty: true,
  };
}
