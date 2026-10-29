import { hostAppPluginRequest } from '@/lib/host-api';
import type { AppPluginDevelopment, AppPluginKind } from '@/types/desktop/app-plugin';
import { buildRuntimeEndpointKey } from '@/types/desktop/runtime-address';

export async function requestPluginDevelopment(kind: AppPluginKind, pluginId?: string, prompt?: string): Promise<void> {
  const { useChatStore } = await import('@/plugins/chat/store');
  if (useChatStore.getState().sessionRuntimeCatalog.status !== 'ready') await useChatStore.getState().bootstrapSessionRuntime();
  const state = useChatStore.getState();
  const conversation = state.currentConversation;
  const endpoint = conversation?.endpoint ?? state.sessionRuntimeCatalog.selectedEndpoint;
  if (!endpoint) throw new Error('请先选择用于开发插件的运行时和 Agent。');
  const target = state.sessionRuntimeCatalog.endpoints.find((candidate) => buildRuntimeEndpointKey(candidate.endpoint) === buildRuntimeEndpointKey(endpoint));
  const scope = conversation
    ? target?.sessionPromptScopes.find((candidate) => candidate.agentId === conversation.agentId)
    : target?.defaultSessionPromptScope;
  if (!scope) throw new Error('当前运行时或 Agent 不支持创建开发会话，请先选择可用的 Agent。');
  const development = await hostAppPluginRequest<AppPluginDevelopment>('development', { kind, ...(pluginId ? { pluginId } : {}) });
  await useChatStore.getState().newSessionForScope(scope);
  const selected = useChatStore.getState().currentConversation;
  if (!selected || selected.kind !== 'draft' || selected.agentId !== scope.agentId
    || buildRuntimeEndpointKey(selected.endpoint) !== buildRuntimeEndpointKey(scope.endpoint)) {
    throw new Error('开发会话未切换到请求的运行时和 Agent，未发送任务。');
  }
  const task = [
    `开发并热安装一个应用${kind === 'reader' ? '文件阅读器' : 'MCP HTTP 连接器'}插件。`,
    pluginId ? `只修改已授权的插件 ${pluginId}，不得更换插件 id。先用 list 的当前 digest 调 app_plugins_inspect({requestId,pluginId,digest}) 读取已安装 manifest/files，在原实现上修正并提升版本；不能靠猜测重写已有功能。` : '创建一个新插件，首次 build 会把本次授权绑定到该插件 id。',
    `本次用户开发授权 requestId=${development.requestId}，kind=${development.kind}，expiresAt=${development.expiresAt}。所有 build/install 必须携带此 requestId；不能创建或扩大授权。`,
    prompt?.trim() ? `用户要求：\n${prompt.trim()}` : '请先根据当前需要明确插件用途；要求不足时先询问用户，不凭空声称已完成。',
    '先调用 app_plugins_sdk 获取当前 SDK，再调用 app_plugins_list 检查现有安装。按 SDK 写 manifest 和自包含 HTML/原生 JavaScript/CSS，connector 仅声明 MCP HTTP。',
    '必须用 app_plugins_build({requestId,manifest,files}) 验证并打包，再用其返回的 packageBase64/digest 调 app_plugins_install。不得运行 npm、脚本、编译器或包代码，不使用任意文件、URL、命令代理代替这条链路。',
    '安装后调用 app_plugins_status，区分 installed/enabled 与 reader 实际 mounted/self-reported ready/error；ready 也不能证明内容正确。无观测就如实说明并请用户在应用打开目标文件检查。安装失败可在同一授权 scope 修正，成功后授权已消费；不能继续任意改包，回退请通过应用管理界面。',
    '若固定工具未出现或返回授权/环境错误，报告具体阻塞，不用文字冒充打包、安装或运行成功。',
  ].join('\n\n');
  const result = await useChatStore.getState().sendMessage(task);
  if (!result.accepted) throw new Error(result.error ?? `插件开发任务未被接受（${result.reason}）。`);
}
