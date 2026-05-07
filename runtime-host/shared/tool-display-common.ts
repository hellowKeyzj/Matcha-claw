export type ToolDisplayActionSpec = {
  label?: string;
  detailKeys?: string[];
};

export type ToolDisplaySpec = {
  title?: string;
  label?: string;
  detailKeys?: string[];
  actions?: Record<string, ToolDisplayActionSpec>;
};

export type CoerceDisplayValueOptions = {
  includeFalse?: boolean;
  includeZero?: boolean;
  includeNonFinite?: boolean;
  maxStringChars?: number;
  maxArrayEntries?: number;
};

type ArgsRecord = Record<string, unknown>;

function joinDetailParts(parts: Array<string | undefined>): string | undefined {
  const normalized = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return normalized.length > 0 ? normalized.join(' · ') : undefined;
}

function quoteText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? `“${trimmed}”` : undefined;
}

function previewText(value: string | undefined, maxChars = 40): string | undefined {
  if (!value) {
    return undefined;
  }
  return coerceDisplayValue(value, { maxStringChars: maxChars });
}

function resolveArrayPreview(
  value: unknown,
  opts: CoerceDisplayValueOptions = {},
): string | undefined {
  return Array.isArray(value) ? coerceDisplayValue(value, opts) : undefined;
}

function asRecord(args: unknown): ArgsRecord | undefined {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as ArgsRecord
    : undefined;
}

export function normalizeToolName(name?: string): string {
  return (name ?? 'tool').trim();
}

export function defaultTitle(name: string): string {
  const cleaned = name.replace(/_/g, ' ').trim();
  if (!cleaned) {
    return '工具';
  }
  return cleaned
    .split(/\s+/)
    .map((part) => `${part.at(0)?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

export function normalizeVerb(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/_/g, ' ');
}

export function resolveActionArg(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record || typeof record.action !== 'string') {
    return undefined;
  }
  const action = record.action.trim();
  return action || undefined;
}

export function coerceDisplayValue(
  value: unknown,
  opts: CoerceDisplayValueOptions = {},
): string | undefined {
  const maxStringChars = opts.maxStringChars ?? 72;
  const maxArrayEntries = opts.maxArrayEntries ?? 3;

  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? '';
    if (!firstLine) {
      return undefined;
    }
    if (firstLine.length > maxStringChars) {
      return `${firstLine.slice(0, Math.max(0, maxStringChars - 1))}…`;
    }
    return firstLine;
  }
  if (typeof value === 'boolean') {
    if (!value && !opts.includeFalse) {
      return undefined;
    }
    return value ? '是' : '否';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return opts.includeNonFinite ? String(value) : undefined;
    }
    if (value === 0 && !opts.includeZero) {
      return undefined;
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((item) => coerceDisplayValue(item, opts))
      .filter((item): item is string => Boolean(item));
    if (values.length === 0) {
      return undefined;
    }
    const preview = values.slice(0, maxArrayEntries).join('、');
    return values.length > maxArrayEntries ? `${preview}…` : preview;
  }
  return undefined;
}

export function lookupValueByPath(args: unknown, path: string): unknown {
  if (!args || typeof args !== 'object') {
    return undefined;
  }
  let current: unknown = args;
  for (const segment of path.split('.')) {
    if (!segment || !current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function formatDetailKey(raw: string, overrides: Record<string, string> = {}): string {
  const segments = raw.split('.').filter(Boolean);
  const last = segments.at(-1) ?? raw;
  const override = overrides[last];
  if (override) {
    return override;
  }
  const cleaned = last.replace(/_/g, ' ').replace(/-/g, ' ');
  const spaced = cleaned.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.trim().toLowerCase() || last.toLowerCase();
}

export function resolvePathArg(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  for (const candidate of [record.path, record.file_path, record.filePath, record.file]) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

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

function resolveBrowserActKindLabel(kind: string | undefined): string | undefined {
  switch (kind) {
    case 'click':
      return '点击';
    case 'dblclick':
      return '双击';
    case 'hover':
      return '悬停';
    case 'focus':
      return '聚焦';
    case 'type':
      return '输入';
    case 'fill':
      return '填写';
    case 'select':
    case 'select_option':
      return '选择';
    case 'press':
      return '按键';
    case 'scroll':
      return '滚动';
    case 'wait':
      return '等待';
    case 'assert':
      return '校验';
    default:
      return kind ? kind.replace(/_/g, ' ') : undefined;
  }
}

function resolveBrowserDetail(action: string | undefined, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record || !action) {
    return undefined;
  }
  const targetUrl = (
    typeof record.targetUrl === 'string' && record.targetUrl.trim()
      ? record.targetUrl.trim()
      : (typeof record.url === 'string' && record.url.trim() ? record.url.trim() : undefined)
  );
  const targetId = typeof record.targetId === 'string' ? record.targetId.trim() : undefined;
  const format = typeof record.format === 'string' ? record.format.trim() : undefined;
  const level = typeof record.level === 'string' ? record.level.trim() : undefined;
  const promptText = typeof record.promptText === 'string' ? record.promptText.trim() : undefined;
  const uploadPaths = resolveArrayPreview(record.paths, { maxArrayEntries: 2, maxStringChars: 36 });
  const ref = typeof record.ref === 'string' ? record.ref.trim() : undefined;
  const inputRef = typeof record.inputRef === 'string' ? record.inputRef.trim() : undefined;
  const element = typeof record.element === 'string' ? record.element.trim() : undefined;
  const request = asRecord(record.request);

  switch (action) {
    case 'status':
      return targetId ? `查看浏览器状态 · ${targetId}` : '查看浏览器状态';
    case 'start':
      return '启动浏览器';
    case 'stop':
      return '关闭浏览器';
    case 'tabs':
      return '查看已打开标签页';
    case 'open':
      return targetUrl ? `打开网页 ${targetUrl}` : '打开网页';
    case 'navigate':
      return targetUrl ? `前往 ${targetUrl}` : (targetId ? `切换到 ${targetId}` : '页面跳转');
    case 'focus':
      return targetId ? `切换到 ${targetId}` : '切换标签页';
    case 'close':
      return targetId ? `关闭 ${targetId}` : '关闭标签页';
    case 'snapshot':
      return targetUrl
        ? `提取页面内容 · ${targetUrl}${format ? ` · ${format}` : ''}`
        : (targetId ? `提取页面内容 · ${targetId}${format ? ` · ${format}` : ''}` : '提取页面内容');
    case 'screenshot':
      return targetUrl ? `截取页面画面 · ${targetUrl}` : (targetId ? `截取页面画面 · ${targetId}` : '截取页面画面');
    case 'console':
      return level ? `查看控制台 · ${level}` : (targetId ? `查看控制台 · ${targetId}` : '查看控制台');
    case 'pdf':
      return targetId ? `导出 PDF · ${targetId}` : '导出 PDF';
    case 'upload':
      return joinDetailParts([
        targetId ? `上传文件到 ${targetId}` : '上传文件',
        uploadPaths,
        ref ? `定位 ${ref}` : undefined,
        inputRef ? `输入框 ${inputRef}` : undefined,
        element ? `元素 ${element}` : undefined,
      ]);
    case 'dialog':
      return joinDetailParts([
        typeof record.accept === 'boolean'
          ? (record.accept ? '确认弹窗' : '取消弹窗')
          : '处理弹窗',
        promptText ? `内容 ${previewText(promptText, 36)}` : undefined,
        targetId ? `来源 ${targetId}` : undefined,
      ]);
    case 'act': {
      const kind = typeof request?.kind === 'string' ? request.kind.trim() : undefined;
      const ref = typeof request?.ref === 'string' ? request.ref.trim() : undefined;
      const selector = typeof request?.selector === 'string' ? request.selector.trim() : undefined;
      const value = typeof request?.value === 'string' ? request.value.trim() : undefined;
      const text = typeof request?.text === 'string' ? request.text.trim() : undefined;
      const target = ref || selector || quoteText(text) || previewText(value, 28);
      const kindLabel = resolveBrowserActKindLabel(kind);
      return joinDetailParts([
        kindLabel ? `${kindLabel}页面元素` : '页面交互',
        target,
        targetId ? `标签页 ${targetId}` : undefined,
      ]);
    }
    default:
      return undefined;
  }
}

function resolveMessageActionDetail(action: string | undefined, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record || !action) {
    return undefined;
  }
  const provider = typeof record.provider === 'string' ? record.provider.trim() : undefined;
  const to = typeof record.to === 'string' ? record.to.trim() : undefined;
  const messageId = typeof record.messageId === 'string' ? record.messageId.trim() : undefined;
  const emoji = typeof record.emoji === 'string' ? record.emoji.trim() : undefined;
  const query = typeof record.query === 'string' ? record.query.trim() : undefined;
  const content = typeof record.content === 'string' ? record.content.trim() : undefined;
  const channelId = typeof record.channelId === 'string' ? record.channelId.trim() : undefined;
  const guildId = typeof record.guildId === 'string' ? record.guildId.trim() : undefined;
  const userId = typeof record.userId === 'string' ? record.userId.trim() : undefined;
  const roleId = typeof record.roleId === 'string' ? record.roleId.trim() : undefined;
  const threadId = typeof record.threadId === 'string' ? record.threadId.trim() : undefined;
  const stickerId = typeof record.stickerId === 'string' ? record.stickerId.trim() : undefined;
  const stickerName = typeof record.stickerName === 'string' ? record.stickerName.trim() : undefined;
  const emojiName = typeof record.emojiName === 'string' ? record.emojiName.trim() : undefined;
  const eventName = typeof record.eventName === 'string' ? record.eventName.trim() : undefined;
  const stickerIds = resolveArrayPreview(record.stickerIds, { maxArrayEntries: 2, maxStringChars: 24 });
  const limit = typeof record.limit === 'number' && Number.isFinite(record.limit) && record.limit > 0
    ? Math.floor(record.limit)
    : undefined;
  const pollQuestion = typeof record.pollQuestion === 'string' ? record.pollQuestion.trim() : undefined;
  const threadName = typeof record.threadName === 'string' ? record.threadName.trim() : undefined;

  switch (action) {
    case 'send':
      return joinDetailParts([
        to ? `发送到 ${to}` : '发送消息',
        provider ? `通过 ${provider}` : undefined,
        content ? `内容 ${previewText(content, 36)}` : undefined,
      ]);
    case 'read':
      return joinDetailParts([
        to ? `查看 ${to} 的消息` : '查看消息',
        limit ? `最近 ${limit} 条` : undefined,
        provider ? `通过 ${provider}` : undefined,
      ]);
    case 'react':
      return joinDetailParts([
        messageId ? `给消息 ${messageId} 添加回应` : '添加回应',
        emoji ? `表情 ${emoji}` : undefined,
        provider ? `通过 ${provider}` : undefined,
      ]);
    case 'reactions':
      return joinDetailParts([
        messageId ? `查看消息 ${messageId} 的回应` : '查看消息回应',
        limit ? `最多 ${limit} 条` : undefined,
        provider ? `通过 ${provider}` : undefined,
      ]);
    case 'edit':
      return joinDetailParts([
        messageId ? `编辑消息 ${messageId}` : undefined,
        to ? `位置 ${to}` : undefined,
      ]);
    case 'delete':
      return joinDetailParts([
        messageId ? `删除消息 ${messageId}` : undefined,
        to ? `位置 ${to}` : undefined,
      ]);
    case 'pin':
      return messageId ? `置顶消息 ${messageId}` : '置顶消息';
    case 'unpin':
      return messageId ? `取消置顶 ${messageId}` : '取消置顶消息';
    case 'list-pins':
      return joinDetailParts([
        to ? `查看 ${to} 的置顶消息` : '查看置顶消息',
        provider ? `通过 ${provider}` : undefined,
      ]);
    case 'poll':
      return joinDetailParts([
        pollQuestion ? `发起投票 ${quoteText(pollQuestion)}` : '发起投票',
        to ? `位置 ${to}` : undefined,
      ]);
    case 'search':
      return joinDetailParts([
        query ? `搜索消息 ${quoteText(query)}` : undefined,
        guildId ? `群组 ${guildId}` : undefined,
        provider ? `通过 ${provider}` : undefined,
      ]);
    case 'thread-create':
      return joinDetailParts([
        threadName ? `创建线程 ${threadName}` : '创建线程',
        channelId ? `频道 ${channelId}` : undefined,
      ]);
    case 'thread-list':
      return joinDetailParts([
        '查看线程列表',
        to ? `位置 ${to}` : undefined,
        channelId ? `频道 ${channelId}` : undefined,
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'thread-reply':
      return joinDetailParts([
        messageId ? `回复线程消息 ${messageId}` : '回复线程',
        channelId ? `频道 ${channelId}` : undefined,
        threadId ? `线程 ${threadId}` : undefined,
      ]);
    case 'permissions':
      return joinDetailParts([
        '查看频道权限',
        channelId ? `频道 ${channelId}` : undefined,
        to ? `目标 ${to}` : undefined,
      ]);
    case 'sticker':
      return joinDetailParts([
        to ? `发送贴纸到 ${to}` : '发送贴纸',
        stickerId ? `贴纸 ${stickerId}` : stickerIds,
      ]);
    case 'member-info':
      return joinDetailParts([
        userId ? `查看成员 ${userId}` : '查看成员信息',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'role-info':
      return guildId ? `查看群组 ${guildId} 的角色信息` : '查看角色信息';
    case 'emoji-list':
      return guildId ? `查看群组 ${guildId} 的表情列表` : '查看表情列表';
    case 'emoji-upload':
      return joinDetailParts([
        emojiName ? `上传表情 ${emojiName}` : '上传表情',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'sticker-upload':
      return joinDetailParts([
        stickerName ? `上传贴纸 ${stickerName}` : '上传贴纸',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'role-add':
      return joinDetailParts([
        userId ? `为 ${userId} 添加角色` : '添加角色',
        roleId ? `角色 ${roleId}` : undefined,
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'role-remove':
      return joinDetailParts([
        userId ? `移除 ${userId} 的角色` : '移除角色',
        roleId ? `角色 ${roleId}` : undefined,
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'channel-info':
      return channelId ? `查看频道 ${channelId} 的信息` : '查看频道信息';
    case 'channel-list':
      return guildId ? `查看群组 ${guildId} 的频道列表` : '查看频道列表';
    case 'voice-status':
      return joinDetailParts([
        userId ? `查看 ${userId} 的语音状态` : '查看语音状态',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'event-list':
      return guildId ? `查看群组 ${guildId} 的事件列表` : '查看事件列表';
    case 'event-create':
      return joinDetailParts([
        eventName ? `创建事件 ${eventName}` : '创建事件',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'timeout':
      return joinDetailParts([
        userId ? `设置 ${userId} 的禁言` : '设置禁言',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'kick':
      return joinDetailParts([
        userId ? `移出成员 ${userId}` : '移出成员',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
    case 'ban':
      return joinDetailParts([
        userId ? `封禁成员 ${userId}` : '封禁成员',
        guildId ? `群组 ${guildId}` : undefined,
      ]);
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

export function resolveActionSpec(
  spec: ToolDisplaySpec | undefined,
  action: string | undefined,
): ToolDisplayActionSpec | undefined {
  if (!spec || !action) {
    return undefined;
  }
  return spec.actions?.[action] ?? undefined;
}

export function resolveDetailFromKeys(
  args: unknown,
  keys: string[],
  opts: {
    mode: 'first' | 'summary';
    coerce?: CoerceDisplayValueOptions;
    maxEntries?: number;
    formatKey?: (raw: string) => string;
  },
): string | undefined {
  if (opts.mode === 'first') {
    for (const key of keys) {
      const value = lookupValueByPath(args, key);
      const display = coerceDisplayValue(value, opts.coerce);
      if (display) {
        return display;
      }
    }
    return undefined;
  }

  const entries: Array<{ label: string; value: string }> = [];
  for (const key of keys) {
    const value = lookupValueByPath(args, key);
    const display = coerceDisplayValue(value, opts.coerce);
    if (!display) {
      continue;
    }
    entries.push({
      label: opts.formatKey ? opts.formatKey(key) : key,
      value: display,
    });
  }
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return entries[0]?.value;
  }

  const seen = new Set<string>();
  const unique: Array<{ label: string; value: string }> = [];
  for (const entry of entries) {
    const token = `${entry.label}:${entry.value}`;
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(entry);
  }
  if (unique.length === 0) {
    return undefined;
  }

  return unique
    .slice(0, opts.maxEntries ?? 8)
    .map((entry) => `${entry.label} ${entry.value}`)
    .join(' · ');
}

export function resolveToolVerbAndDetail(params: {
  toolKey: string;
  args?: unknown;
  meta?: string;
  action?: string;
  spec?: ToolDisplaySpec;
  fallbackDetailKeys?: string[];
  detailMode: 'first' | 'summary';
  detailCoerce?: CoerceDisplayValueOptions;
  detailMaxEntries?: number;
  detailFormatKey?: (raw: string) => string;
  resolveExecDetail?: (args: unknown) => string | undefined;
}): { verb?: string; detail?: string } {
  const actionSpec = resolveActionSpec(params.spec, params.action);
  const fallbackVerb =
    params.toolKey === 'web_search'
      ? '搜索'
      : params.toolKey === 'web_fetch'
        ? '抓取'
        : params.toolKey.replace(/_/g, ' ').replace(/\./g, ' ');
  const verb = normalizeVerb(actionSpec?.label ?? params.action ?? fallbackVerb);

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

  const detailKeys =
    actionSpec?.detailKeys ?? params.spec?.detailKeys ?? params.fallbackDetailKeys ?? [];
  if (!detail && detailKeys.length > 0) {
    detail = resolveDetailFromKeys(params.args, detailKeys, {
      mode: params.detailMode,
      coerce: params.detailCoerce,
      maxEntries: params.detailMaxEntries,
      formatKey: params.detailFormatKey,
    });
  }
  if (!detail && params.meta) {
    detail = params.meta;
  }

  return { verb, detail };
}

export function resolveToolVerbAndDetailForArgs(params: {
  toolKey: string;
  args?: unknown;
  meta?: string;
  spec?: ToolDisplaySpec;
  fallbackDetailKeys?: string[];
  detailMode: 'first' | 'summary';
  detailCoerce?: CoerceDisplayValueOptions;
  detailMaxEntries?: number;
  detailFormatKey?: (raw: string) => string;
  resolveExecDetail?: (args: unknown) => string | undefined;
}): { verb?: string; detail?: string } {
  return resolveToolVerbAndDetail({
    toolKey: params.toolKey,
    args: params.args,
    meta: params.meta,
    action: resolveActionArg(params.args),
    spec: params.spec,
    fallbackDetailKeys: params.fallbackDetailKeys,
    detailMode: params.detailMode,
    detailCoerce: params.detailCoerce,
    detailMaxEntries: params.detailMaxEntries,
    detailFormatKey: params.detailFormatKey,
    resolveExecDetail: params.resolveExecDetail,
  });
}

export function formatToolDetailText(
  detail: string | undefined,
  opts: { prefixWithWith?: boolean } = {},
): string | undefined {
  if (!detail) {
    return undefined;
  }
  const normalized = detail.includes(' · ')
    ? detail
        .split(' · ')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join('，')
    : detail;
  if (!normalized) {
    return undefined;
  }
  return opts.prefixWithWith ? `执行：${normalized}` : normalized;
}
