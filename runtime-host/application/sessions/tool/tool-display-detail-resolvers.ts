import {
  asRecord,
  joinDetailParts,
  previewText,
  quoteText,
  resolveArrayPreview,
  resolvePathArg,
} from './tool-display-format';
import { resolveBrowserDetail } from './tool-display-browser-detail';
import { resolveMessageActionDetail } from './tool-display-message-detail';

export function resolveReadDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const path = resolvePathArg(record);
  if (!path) {
    return undefined;
  }

  const offsetRaw =
    typeof record.offset === 'number' && Number.isFinite(record.offset)
      ? Math.floor(record.offset)
      : undefined;
  const limitRaw =
    typeof record.limit === 'number' && Number.isFinite(record.limit)
      ? Math.floor(record.limit)
      : undefined;

  const offset = offsetRaw !== undefined ? Math.max(1, offsetRaw) : undefined;
  const limit = limitRaw !== undefined ? Math.max(1, limitRaw) : undefined;

  if (offset !== undefined && limit !== undefined) {
    return `读取 ${offset}-${offset + limit - 1} 行 · ${path}`;
  }
  if (offset !== undefined) {
    return `从第 ${offset} 行读取 · ${path}`;
  }
  if (limit !== undefined) {
    return `读取前 ${limit} 行 · ${path}`;
  }
  return `读取 · ${path}`;
}

export function resolveWriteDetail(toolKey: string, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const path =
    resolvePathArg(record) ?? (typeof record.url === 'string' ? record.url.trim() : undefined);
  if (!path) {
    return undefined;
  }

  if (toolKey === 'attach') {
    return `附加 ${path}`;
  }

  const content =
    typeof record.content === 'string'
      ? record.content
      : typeof record.newText === 'string'
        ? record.newText
        : typeof record.new_string === 'string'
          ? record.new_string
          : undefined;

  if (toolKey === 'edit') {
    return content ? `修改 ${path} · ${content.length} 字符` : `修改 ${path}`;
  }

  return content ? `写入 ${path} · ${content.length} 字符` : `写入 ${path}`;
}

export function resolveWebSearchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const query = typeof record.query === 'string' ? record.query.trim() : undefined;
  const count =
    typeof record.count === 'number' && Number.isFinite(record.count) && record.count > 0
      ? Math.floor(record.count)
      : undefined;

  if (!query) {
    return undefined;
  }

  return count !== undefined ? `搜索“${query}” · Top ${count}` : `搜索“${query}”`;
}

export function resolveWebFetchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const url = typeof record.url === 'string' ? record.url.trim() : undefined;
  if (!url) {
    return undefined;
  }

  const mode = typeof record.extractMode === 'string' ? record.extractMode.trim() : undefined;
  const maxChars =
    typeof record.maxChars === 'number' && Number.isFinite(record.maxChars) && record.maxChars > 0
      ? Math.floor(record.maxChars)
      : undefined;

  const suffix = [
    mode ? mode : undefined,
    maxChars !== undefined ? `最多 ${maxChars} 字` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');

  return suffix ? `抓取 ${url} · ${suffix}` : `抓取 ${url}`;
}

function resolveSessionStatusDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const sessionKey = typeof record.sessionKey === 'string' ? record.sessionKey.trim() : undefined;
  const model = typeof record.model === 'string' ? record.model.trim() : undefined;
  return joinDetailParts([
    sessionKey ? `查看会话 ${sessionKey}` : undefined,
    model ? `模型 ${model}` : undefined,
  ]);
}

function resolveSessionsListDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const limit = typeof record.limit === 'number' && Number.isFinite(record.limit) && record.limit > 0
    ? Math.floor(record.limit)
    : undefined;
  const activeMinutes = typeof record.activeMinutes === 'number' && Number.isFinite(record.activeMinutes) && record.activeMinutes > 0
    ? Math.floor(record.activeMinutes)
    : undefined;
  const messageLimit = typeof record.messageLimit === 'number' && Number.isFinite(record.messageLimit) && record.messageLimit > 0
    ? Math.floor(record.messageLimit)
    : undefined;
  const kinds = Array.isArray(record.kinds)
    ? record.kinds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  return joinDetailParts([
    kinds.length > 0 ? `查看 ${kinds.join('、')} 会话` : undefined,
    activeMinutes ? `最近 ${activeMinutes} 分钟活跃` : undefined,
    messageLimit ? `每个会话最多 ${messageLimit} 条消息` : undefined,
    limit ? `最多 ${limit} 个结果` : undefined,
  ]);
}

function resolveSessionsSendDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const label = typeof record.label === 'string' ? record.label.trim() : undefined;
  const sessionKey = typeof record.sessionKey === 'string' ? record.sessionKey.trim() : undefined;
  const timeoutSeconds = typeof record.timeoutSeconds === 'number' && Number.isFinite(record.timeoutSeconds) && record.timeoutSeconds > 0
    ? Math.floor(record.timeoutSeconds)
    : undefined;
  const target = label || sessionKey;
  return joinDetailParts([
    target ? `发送到 ${target}` : undefined,
    timeoutSeconds ? `超时 ${timeoutSeconds} 秒` : undefined,
  ]);
}

function resolveSessionsHistoryDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const sessionKey = typeof record.sessionKey === 'string' ? record.sessionKey.trim() : undefined;
  const limit = typeof record.limit === 'number' && Number.isFinite(record.limit) && record.limit > 0
    ? Math.floor(record.limit)
    : undefined;
  const includeTools = record.includeTools === true;
  return joinDetailParts([
    sessionKey ? `查看 ${sessionKey}` : undefined,
    limit ? `最近 ${limit} 条` : undefined,
    includeTools ? '包含工具过程' : undefined,
  ]);
}

function resolveSessionsSpawnDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const label = typeof record.label === 'string' ? record.label.trim() : undefined;
  const task = typeof record.task === 'string' ? record.task.trim() : undefined;
  const agentId = typeof record.agentId === 'string' ? record.agentId.trim() : undefined;
  const model = typeof record.model === 'string' ? record.model.trim() : undefined;
  return joinDetailParts([
    label ? `创建 ${label}` : undefined,
    task ? `任务 ${previewText(task, 40)}` : undefined,
    agentId ? `智能体 ${agentId}` : undefined,
    model ? `模型 ${model}` : undefined,
  ]);
}

function resolveMemorySearchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  const query = record && typeof record.query === 'string' ? record.query.trim() : undefined;
  return query ? `搜索记忆 ${quoteText(query)}` : undefined;
}

function resolveMemoryGetDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const path = resolvePathArg(record);
  const from = typeof record.from === 'number' && Number.isFinite(record.from) ? Math.max(1, Math.floor(record.from)) : undefined;
  const lines = typeof record.lines === 'number' && Number.isFinite(record.lines) ? Math.max(1, Math.floor(record.lines)) : undefined;
  if (!path) {
    return undefined;
  }
  if (from !== undefined && lines !== undefined) {
    return `读取 ${from}-${from + lines - 1} 行 · ${path}`;
  }
  if (from !== undefined) {
    return `从第 ${from} 行读取 · ${path}`;
  }
  if (lines !== undefined) {
    return `读取前 ${lines} 行 · ${path}`;
  }
  return `读取记忆 · ${path}`;
}

function resolveCodeExecutionDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  const task = record && typeof record.task === 'string' ? record.task.trim() : undefined;
  return task ? `执行代码任务 · ${previewText(task, 48)}` : undefined;
}

function resolveProcessDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : undefined;
  const pid = typeof record.pid === 'number' && Number.isFinite(record.pid) ? Math.floor(record.pid) : undefined;
  const signal = typeof record.signal === 'string' ? record.signal.trim() : undefined;
  return joinDetailParts([
    sessionId ? `查看进程 ${sessionId}` : undefined,
    pid != null ? `PID ${pid}` : undefined,
    signal ? `信号 ${signal}` : undefined,
  ]);
}

function resolveAgentsListDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return '查看智能体列表';
  }
  const limit = typeof record.limit === 'number' && Number.isFinite(record.limit) && record.limit > 0
    ? Math.floor(record.limit)
    : undefined;
  const kind = typeof record.kind === 'string' ? record.kind.trim() : undefined;
  return joinDetailParts([
    kind ? `查看 ${kind} 智能体` : '查看智能体列表',
    limit ? `最多 ${limit} 个` : undefined,
  ]);
}

function resolveWhatsappLoginDetail(action: string | undefined, args: unknown): string | undefined {
  const record = asRecord(args);
  const session = record && typeof record.sessionId === 'string' ? record.sessionId.trim() : undefined;
  switch (action) {
    case 'start':
      return session ? `开始 WhatsApp 登录 · ${session}` : '开始 WhatsApp 登录';
    case 'wait':
      return session ? `等待 WhatsApp 验证 · ${session}` : '等待 WhatsApp 验证';
    default:
      return undefined;
  }
}

function resolveToolCallDetail(toolKey: string, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const name = typeof record.name === 'string' ? record.name.trim() : undefined;
  const id = typeof record.id === 'string' ? record.id.trim() : undefined;
  return joinDetailParts([
    name ? `调用 ${name}` : `记录 ${toolKey}`,
    id ? `编号 ${id}` : undefined,
  ]);
}

function resolveApplyPatchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return '应用补丁';
  }
  const files = resolveArrayPreview(record.files, { maxArrayEntries: 3, maxStringChars: 28 });
  const path = resolvePathArg(record);
  return joinDetailParts([
    '应用补丁',
    files ? `文件 ${files}` : undefined,
    !files && path ? path : undefined,
  ]);
}

function resolveCronDetail(action: string | undefined, args: unknown): string | undefined {
  const record = asRecord(args);
  const job = asRecord(record?.job);
  const id = typeof record?.id === 'string' ? record.id.trim() : undefined;
  switch (action) {
    case 'list':
      return '查看定时任务';
    case 'status':
      return '查看任务状态';
    case 'add':
      return joinDetailParts([
        typeof job?.name === 'string' ? `新建任务 ${job.name}` : '新建定时任务',
        typeof job?.schedule === 'string' ? `计划 ${job.schedule}` : undefined,
        typeof job?.cron === 'string' ? `Cron ${job.cron}` : undefined,
      ]);
    case 'update':
      return id ? `更新任务 ${id}` : '更新定时任务';
    case 'remove':
      return id ? `删除任务 ${id}` : '删除定时任务';
    case 'run':
      return id ? `立即执行 ${id}` : '立即执行任务';
    case 'runs':
      return id ? `查看 ${id} 的运行记录` : '查看运行记录';
    case 'wake': {
      const text = typeof record?.text === 'string' ? record.text.trim() : undefined;
      return text ? `发送唤醒内容 · ${previewText(text, 40)}` : '唤醒任务';
    }
    default:
      return undefined;
  }
}

function resolveNodesDetail(action: string | undefined, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record || !action) {
    return undefined;
  }
  const nodeId = typeof record.nodeId === 'string' ? record.nodeId.trim() : undefined;
  const requestId = typeof record.requestId === 'string' ? record.requestId.trim() : undefined;
  const title = typeof record.title === 'string' ? record.title.trim() : undefined;
  switch (action) {
    case 'status':
      return nodeId ? `查看 ${nodeId} 的状态` : '查看节点状态';
    case 'describe':
      return nodeId ? `查看 ${nodeId} 的详情` : '查看节点详情';
    case 'pending':
      return '查看待处理请求';
    case 'approve':
      return requestId ? `批准请求 ${requestId}` : '批准请求';
    case 'reject':
      return requestId ? `拒绝请求 ${requestId}` : '拒绝请求';
    case 'notify':
      return joinDetailParts([
        nodeId ? `向 ${nodeId} 发送通知` : '发送通知',
        title ? `标题 ${title}` : undefined,
      ]);
    case 'camera_snap':
      return nodeId ? `拍摄现场照片 · ${nodeId}` : '拍摄现场照片';
    case 'camera_list':
      return nodeId ? `查看 ${nodeId} 的相机列表` : '查看相机列表';
    case 'camera_clip':
      return nodeId ? `录制现场视频 · ${nodeId}` : '录制现场视频';
    case 'screen_record':
      return nodeId ? `录制屏幕画面 · ${nodeId}` : '录制屏幕画面';
    default:
      return undefined;
  }
}

function resolveCanvasDetail(action: string | undefined, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record || !action) {
    return undefined;
  }
  const nodeId = typeof record.nodeId === 'string' ? record.nodeId.trim() : undefined;
  const url = typeof record.url === 'string' ? record.url.trim() : undefined;
  switch (action) {
    case 'present':
      return nodeId ? `在 ${nodeId} 展示画布` : '展示画布';
    case 'hide':
      return nodeId ? `收起 ${nodeId} 的画布` : '收起画布';
    case 'navigate':
      return url ? `将画布切换到 ${url}` : (nodeId ? `切换 ${nodeId} 的画布` : '切换画布');
    case 'eval':
      return nodeId ? `在 ${nodeId} 执行脚本` : '执行画布脚本';
    case 'snapshot':
      return nodeId ? `抓取 ${nodeId} 的画布快照` : '抓取画布快照';
    case 'a2ui_push':
      return nodeId ? `推送界面数据 · ${nodeId}` : '推送界面数据';
    case 'a2ui_reset':
      return nodeId ? `重置界面状态 · ${nodeId}` : '重置界面状态';
    default:
      return undefined;
  }
}

function resolveGatewayDetail(action: string | undefined, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record || action !== 'restart') {
    return undefined;
  }
  const reason = typeof record.reason === 'string' ? record.reason.trim() : undefined;
  const delayMs = typeof record.delayMs === 'number' && Number.isFinite(record.delayMs)
    ? Math.floor(record.delayMs)
    : undefined;
  return joinDetailParts([
    '重启网关',
    reason ? `原因 ${reason}` : undefined,
    delayMs != null ? `延迟 ${delayMs}ms` : undefined,
  ]);
}

function resolveSubagentsDetail(action: string | undefined, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record || !action) {
    return undefined;
  }
  const target = typeof record.target === 'string' ? record.target.trim() : undefined;
  const recentMinutes = typeof record.recentMinutes === 'number' && Number.isFinite(record.recentMinutes)
    ? Math.floor(record.recentMinutes)
    : undefined;
  switch (action) {
    case 'list':
      return recentMinutes ? `查看最近 ${recentMinutes} 分钟的智能体` : '查看智能体列表';
    case 'kill':
      return target ? `结束 ${target}` : '结束智能体';
    case 'steer':
      return target ? `转交给 ${target}` : '转交智能体';
    default:
      return undefined;
  }
}

export function resolveKnownToolDetail(params: {
  toolKey: string;
  args?: unknown;
  action?: string;
  resolveExecDetail?: (args: unknown) => string | undefined;
}): string | undefined {
  let detail: string | undefined;
  if (params.toolKey === 'exec' || params.toolKey === 'bash') {
    detail = params.resolveExecDetail?.(params.args);
  }
  if (!detail && params.toolKey === 'browser') {
    detail = resolveBrowserDetail(params.action, params.args);
  }
  if (!detail && params.toolKey === 'canvas') {
    detail = resolveCanvasDetail(params.action, params.args);
  }
  if (!detail && params.toolKey === 'nodes') {
    detail = resolveNodesDetail(params.action, params.args);
  }
  if (!detail && params.toolKey === 'cron') {
    detail = resolveCronDetail(params.action, params.args);
  }
  if (!detail && params.toolKey === 'message') {
    detail = resolveMessageActionDetail(params.action, params.args);
  }
  if (!detail && params.toolKey === 'gateway') {
    detail = resolveGatewayDetail(params.action, params.args);
  }
  if (!detail && params.toolKey === 'subagents') {
    detail = resolveSubagentsDetail(params.action, params.args);
  }
  if (!detail && params.toolKey === 'session_status') {
    detail = resolveSessionStatusDetail(params.args);
  }
  if (!detail && params.toolKey === 'sessions_list') {
    detail = resolveSessionsListDetail(params.args);
  }
  if (!detail && params.toolKey === 'sessions_send') {
    detail = resolveSessionsSendDetail(params.args);
  }
  if (!detail && params.toolKey === 'sessions_history') {
    detail = resolveSessionsHistoryDetail(params.args);
  }
  if (!detail && params.toolKey === 'sessions_spawn') {
    detail = resolveSessionsSpawnDetail(params.args);
  }
  if (!detail && params.toolKey === 'memory_search') {
    detail = resolveMemorySearchDetail(params.args);
  }
  if (!detail && params.toolKey === 'memory_get') {
    detail = resolveMemoryGetDetail(params.args);
  }
  if (!detail && params.toolKey === 'code_execution') {
    detail = resolveCodeExecutionDetail(params.args);
  }
  if (!detail && params.toolKey === 'process') {
    detail = resolveProcessDetail(params.args);
  }
  if (!detail && params.toolKey === 'agents_list') {
    detail = resolveAgentsListDetail(params.args);
  }
  if (!detail && params.toolKey === 'whatsapp_login') {
    detail = resolveWhatsappLoginDetail(params.action, params.args);
  }
  if (!detail && (params.toolKey === 'tool_call' || params.toolKey === 'tool_call_update')) {
    detail = resolveToolCallDetail(params.toolKey, params.args);
  }
  if (!detail && params.toolKey === 'apply_patch') {
    detail = resolveApplyPatchDetail(params.args);
  }
  if (!detail && params.toolKey === 'read') {
    detail = resolveReadDetail(params.args);
  }
  if (
    !detail &&
    (params.toolKey === 'write' || params.toolKey === 'edit' || params.toolKey === 'attach')
  ) {
    detail = resolveWriteDetail(params.toolKey, params.args);
  }
  if (!detail && params.toolKey === 'web_search') {
    detail = resolveWebSearchDetail(params.args);
  }
  if (!detail && params.toolKey === 'web_fetch') {
    detail = resolveWebFetchDetail(params.args);
  }
  return detail;
}
