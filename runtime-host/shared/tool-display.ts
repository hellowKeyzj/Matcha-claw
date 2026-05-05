import TOOL_DISPLAY_OVERRIDES_JSON from './tool-display-overrides.json';
import TOOL_DISPLAY_SHARED_JSON from './tool-display-shared-spec.json';
import {
  defaultTitle,
  formatDetailKey,
  formatToolDetailText,
  normalizeToolName,
  resolveToolVerbAndDetailForArgs,
  type ToolDisplaySpec,
  type ToolDisplayActionSpec,
} from './tool-display-common';
import { resolveExecDetail } from './tool-display-exec';
type ToolDisplayConfig = {
  fallback?: ToolDisplaySpec;
  tools?: Record<string, ToolDisplaySpec>;
};

export type ToolDisplay = {
  name: string;
  title: string;
  label: string;
  verb?: string;
  detail?: string;
};

const DETAIL_LABEL_OVERRIDES: Record<string, string> = {
  agentId: '智能体',
  sessionKey: '会话',
  targetId: '目标',
  targetUrl: '网址',
  nodeId: '节点',
  requestId: '请求',
  messageId: '消息',
  threadId: '线程',
  channelId: '频道',
  guildId: '群组',
  userId: '用户',
  runTimeoutSeconds: '超时',
  timeoutSeconds: '超时',
  includeTools: '工具',
  pollQuestion: '投票',
  maxChars: '最多',
  extractMode: '模式',
  fileName: '文件',
  recentMinutes: '最近',
  activeMinutes: '活跃',
  messageLimit: '消息数',
  count: '数量',
  query: '关键词',
  limit: '限制',
  from: '起始',
  lines: '行数',
  task: '任务',
  cleanup: '清理',
  model: '模型',
  provider: '渠道',
  to: '目标',
};

const MAX_DETAIL_ENTRIES = 8;
const TOOL_DISPLAY_SHARED_CONFIG = TOOL_DISPLAY_SHARED_JSON as ToolDisplayConfig;
const TOOL_DISPLAY_OVERRIDES = TOOL_DISPLAY_OVERRIDES_JSON as ToolDisplayConfig;
const FALLBACK = TOOL_DISPLAY_OVERRIDES.fallback
  ?? TOOL_DISPLAY_SHARED_CONFIG.fallback
  ?? { detailKeys: [] };
const TOOL_MAP = Object.assign({}, TOOL_DISPLAY_SHARED_CONFIG.tools, TOOL_DISPLAY_OVERRIDES.tools);

function shortenHomeInString(input: string): string {
  if (!input) {
    return input;
  }
  const patterns = [
    { re: /^\/Users\/[^/]+(\/|$)/, replacement: '~$1' },
    { re: /^\/home\/[^/]+(\/|$)/, replacement: '~$1' },
    { re: /^C:\\Users\\[^\\]+(\\|$)/i, replacement: '~$1' },
  ] as const;
  for (const pattern of patterns) {
    if (pattern.re.test(input)) {
      return input.replace(pattern.re, pattern.replacement);
    }
  }
  return input;
}

export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  meta?: string;
}): ToolDisplay {
  const name = normalizeToolName(params.name);
  const key = name.toLowerCase();
  const spec: ToolDisplaySpec | undefined = TOOL_MAP[key];
  const title = spec?.title ?? defaultTitle(name);
  const label = spec?.label ?? title;
  const resolved = resolveToolVerbAndDetailForArgs({
    toolKey: key,
    args: params.args,
    meta: params.meta,
    spec,
    fallbackDetailKeys: FALLBACK.detailKeys,
    detailMode: 'summary',
    detailMaxEntries: MAX_DETAIL_ENTRIES,
    detailFormatKey: (raw) => formatDetailKey(raw, DETAIL_LABEL_OVERRIDES),
    resolveExecDetail,
  });
  let detail = resolved.detail;

  if (detail) {
    detail = shortenHomeInString(detail);
  }

  return {
    name,
    title,
    label,
    ...(resolved.verb ? { verb: resolved.verb } : {}),
    ...(detail ? { detail } : {}),
  };
}

export interface ToolDisplaySummary {
  name: string;
  title: string;
  label: string;
  detail?: string;
}

export function resolveToolDisplaySummary(params: {
  name?: string;
  args?: unknown;
  meta?: string;
}): ToolDisplaySummary {
  const display = resolveToolDisplay(params);
  return {
    name: display.name,
    title: display.label || display.title,
    label: display.label,
    ...(display.detail ? { detail: formatToolDetail(display) } : {}),
  };
}

export function formatToolDetail(display: ToolDisplay): string | undefined {
  return formatToolDetailText(display.detail);
}

export function formatToolSummary(display: ToolDisplaySummary): string {
  return display.detail
    ? `${display.title}：${display.detail}`
    : display.title;
}
