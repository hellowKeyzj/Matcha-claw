import type { SessionRenderToolCard, SessionRenderToolStatusKind } from '../../../types/session/tool-card';
import type {
  ToolActivityTextBlock,
  ToolActivityTone,
  ToolActivityTrailingLabel,
  ToolActivityViewModel,
} from '../tool-activity-view-model';
import { extractToolResultContentBlockText, parseToolResultJson } from './result-content';

const TITLE_TEXT_LIMIT = 72;
const BODY_TEXT_LIMIT = 1200;

const DISPATCH_TOOL_NAMES = new Set([
  'agent',
  'task',
  'subagent',
  'delegate',
]);
const SEND_MESSAGE_TOOL_NAMES = new Set(['sendmessage']);
const TASK_OUTPUT_TOOL_NAMES = new Set(['taskoutput', 'readtaskoutput']);
const TASK_STOP_TOOL_NAMES = new Set(['taskstop', 'stoptask']);

type AgentToolKind = 'dispatch' | 'sendMessage' | 'taskOutput' | 'taskStop';

interface AgentToolInputFields {
  description?: string;
  prompt?: string;
  subagentType?: string;
  model?: string;
  to?: string;
  message?: string;
  taskId?: string;
}

interface AgentToolOutputFields {
  status?: string;
  result?: string;
  summary?: string;
  agentId?: string;
  name?: string;
}

type AgentToolInputRecord = Record<string, unknown>;
type AgentToolOutputRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentToolInputRecord(value: unknown): value is AgentToolInputRecord {
  return isRecord(value);
}

function isAgentToolOutputRecord(value: unknown): value is AgentToolOutputRecord {
  return isRecord(value);
}

function normalizeToolName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function resolveAgentToolKind(toolName: string): AgentToolKind | null {
  const normalized = normalizeToolName(toolName);
  if (DISPATCH_TOOL_NAMES.has(normalized)) return 'dispatch';
  if (SEND_MESSAGE_TOOL_NAMES.has(normalized)) return 'sendMessage';
  if (TASK_OUTPUT_TOOL_NAMES.has(normalized)) return 'taskOutput';
  if (TASK_STOP_TOOL_NAMES.has(normalized)) return 'taskStop';
  return null;
}

function normalizeText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readPrimitiveText(value: unknown): string | null {
  if (typeof value === 'string') return normalizeText(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

function readFieldText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const text = readPrimitiveText(record[key]);
    if (text) return text;
  }
  return null;
}

function readDisplayFieldText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const field = record[key];
    const blockText = extractToolResultContentBlockText(field);
    if (blockText) return blockText;

    const text = readPrimitiveText(field);
    if (!text) continue;

    const nested = parseStructuredText(text);
    const nestedBlockText = extractToolResultContentBlockText(nested);
    if (nestedBlockText) return nestedBlockText;

    if (isAgentToolOutputRecord(nested)) {
      const nestedText = readFieldText(nested, ['summary', 'result', 'status', 'name', 'agentId', 'agent_id']);
      if (nestedText) return nestedText;
      continue;
    }

    return text;
  }
  return null;
}

function isJsonLikeText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"');
}

function parseStructuredText(text: string | null | undefined): unknown {
  return parseToolResultJson(text);
}

function readTargetText(value: unknown): string | null {
  const text = readPrimitiveText(value);
  if (text) return text;
  if (!isRecord(value)) return null;
  return readFieldText(value, ['name', 'agentId', 'agent_id', 'task_id', 'taskId', 'id']);
}

function readAgentToolInput(tool: SessionRenderToolCard): AgentToolInputFields {
  const input = isAgentToolInputRecord(tool.input)
    ? tool.input
    : parseStructuredText(tool.inputText);

  if (!isAgentToolInputRecord(input)) {
    return {};
  }

  return {
    description: readFieldText(input, ['description']) ?? undefined,
    prompt: readFieldText(input, ['prompt']) ?? undefined,
    subagentType: readFieldText(input, ['subagent_type', 'subagentType']) ?? undefined,
    model: readFieldText(input, ['model']) ?? undefined,
    to: readTargetText(input.to) ?? undefined,
    message: readFieldText(input, ['message']) ?? undefined,
    taskId: readFieldText(input, ['task_id', 'taskId']) ?? undefined,
  };
}

function readResultText(tool: SessionRenderToolCard): string | null {
  if (tool.result.kind === 'text' || tool.result.kind === 'json') {
    return normalizeText(tool.result.bodyText) ?? normalizeText(tool.result.collapsedPreview);
  }
  if (tool.result.kind === 'canvas') {
    return normalizeText(tool.result.rawText ?? '') ?? normalizeText(tool.result.collapsedPreview);
  }
  return null;
}

function readAgentToolOutputRecord(value: unknown): AgentToolOutputFields {
  const blockText = extractToolResultContentBlockText(value);
  if (blockText) {
    return { result: blockText };
  }

  if (!isAgentToolOutputRecord(value)) {
    const text = readPrimitiveText(value);
    return text && !isJsonLikeText(text) ? { result: text } : {};
  }

  const resultField = value.result;
  const nestedResult = isAgentToolOutputRecord(resultField)
    ? readAgentToolOutputRecord(resultField)
    : {};

  return {
    status: readFieldText(value, ['status', 'state']) ?? nestedResult.status,
    result: readDisplayFieldText(value, ['result']) ?? nestedResult.result,
    summary: readDisplayFieldText(value, ['summary']) ?? nestedResult.summary,
    agentId: readFieldText(value, ['agentId', 'agent_id']) ?? nestedResult.agentId,
    name: readFieldText(value, ['name']) ?? nestedResult.name,
  };
}

function mergeOutputFields(...fields: AgentToolOutputFields[]): AgentToolOutputFields {
  return fields.reduce<AgentToolOutputFields>((merged, field) => ({
    status: merged.status ?? field.status,
    result: merged.result ?? field.result,
    summary: merged.summary ?? field.summary,
    agentId: merged.agentId ?? field.agentId,
    name: merged.name ?? field.name,
  }), {});
}

function readAgentToolOutput(tool: SessionRenderToolCard): AgentToolOutputFields {
  const resultText = readResultText(tool);
  const parsedResult = parseStructuredText(resultText);
  const contentBlockResult = extractToolResultContentBlockText(parsedResult);
  const fallbackResult = contentBlockResult
    ? { result: contentBlockResult }
    : resultText && !isJsonLikeText(resultText) ? { result: resultText } : {};

  return mergeOutputFields(
    readAgentToolOutputRecord(tool.output),
    readAgentToolOutputRecord(parsedResult),
    fallbackResult,
    { summary: normalizeText(tool.summary ?? '') ?? undefined },
  );
}

function truncateText(text: string, limit: number): string {
  const normalized = text.trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function formatToolDuration(durationMs?: number): string | null {
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatStatus(status: string): string {
  const normalized = normalizeToolName(status);
  if (normalized === 'running' || normalized === 'inprogress' || normalized === 'pending') return '运行中';
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'success' || normalized === 'succeeded') return '完成';
  if (normalized === 'failed' || normalized === 'error') return '失败';
  if (normalized === 'stopped' || normalized === 'cancelled' || normalized === 'canceled') return '已停止';
  return status;
}

function isRunningStatus(status?: string): boolean {
  if (!status) return false;
  const normalized = normalizeToolName(status);
  return normalized === 'running' || normalized === 'inprogress' || normalized === 'pending';
}

function isErrorStatus(status?: string): boolean {
  if (!status) return false;
  const normalized = normalizeToolName(status);
  return normalized === 'failed' || normalized === 'error';
}

function resolveToolTone(toolStatus: SessionRenderToolStatusKind, outputStatus?: string): ToolActivityTone {
  if (toolStatus === 'running' || isRunningStatus(outputStatus)) return 'running';
  if (toolStatus === 'error' || isErrorStatus(outputStatus)) return 'danger';
  if (toolStatus === 'missing_result') return 'muted';
  return 'neutral';
}

function resolveAgentLabel(input: AgentToolInputFields, output: AgentToolOutputFields): string | null {
  return output.name ?? input.to ?? output.agentId ?? input.taskId ?? input.subagentType ?? null;
}

function resolveTitle(kind: AgentToolKind, input: AgentToolInputFields, output: AgentToolOutputFields): string {
  const agent = resolveAgentLabel(input, output);

  if (kind === 'sendMessage') {
    return agent ? `发送给 ${truncateText(agent, TITLE_TEXT_LIMIT)}` : '发送消息';
  }

  if (kind === 'taskOutput') {
    return '读取任务输出';
  }

  if (kind === 'taskStop') {
    return agent ? `停止 ${truncateText(agent, TITLE_TEXT_LIMIT)}` : '停止任务';
  }

  const description = input.description ?? input.prompt ?? agent;
  return description ? `分派 ${truncateText(description, TITLE_TEXT_LIMIT)}` : '分派任务';
}

function addTextBlock(
  textBlocks: ToolActivityTextBlock[],
  kind: ToolActivityTextBlock['kind'],
  title: string,
  text: string | null | undefined,
  copyable = false,
): void {
  const normalized = normalizeText(text ?? '');
  if (!normalized) return;
  textBlocks.push({
    kind,
    title,
    text: truncateText(normalized, BODY_TEXT_LIMIT),
    copyable,
  });
}

function addInfoBlock(
  textBlocks: ToolActivityTextBlock[],
  input: AgentToolInputFields,
  output: AgentToolOutputFields,
): void {
  const rows = [
    input.subagentType ? `类型：${input.subagentType}` : null,
    input.model ? `模型：${input.model}` : null,
    output.name ? `名称：${output.name}` : null,
    output.agentId ? `代理：${output.agentId}` : null,
    input.taskId ? `任务：${input.taskId}` : null,
    input.to ? `目标：${input.to}` : null,
  ].filter((row): row is string => row !== null);

  if (rows.length === 0) return;
  addTextBlock(textBlocks, 'notice', '任务信息', rows.join('\n'));
}

function buildTextBlocks(
  kind: AgentToolKind,
  input: AgentToolInputFields,
  output: AgentToolOutputFields,
): ToolActivityTextBlock[] {
  const textBlocks: ToolActivityTextBlock[] = [];

  if (kind === 'sendMessage') {
    addTextBlock(textBlocks, 'input', '消息', input.message);
  } else if (kind === 'dispatch') {
    addTextBlock(textBlocks, 'input', '任务描述', input.description);
    addTextBlock(textBlocks, 'input', '目标', input.prompt);
  }

  addInfoBlock(textBlocks, input, output);
  addTextBlock(textBlocks, 'output', '结果摘要', output.summary);
  if (output.result !== output.summary) {
    addTextBlock(textBlocks, 'output', '结果', output.result);
  }
  if (output.status && !output.summary && !output.result) {
    addTextBlock(textBlocks, 'notice', '状态', formatStatus(output.status));
  }

  return textBlocks;
}

function buildTrailingLabels(
  tool: SessionRenderToolCard,
  title: string,
  input: AgentToolInputFields,
  output: AgentToolOutputFields,
): ToolActivityTrailingLabel[] {
  const labels: ToolActivityTrailingLabel[] = [];
  if (output.status) {
    const status = formatStatus(output.status);
    if (status !== title) labels.push({ text: status, tone: 'muted' });
  }
  if (tool.status === 'running' && title !== '运行中' && !isRunningStatus(output.status)) {
    labels.push({ text: '运行中', tone: 'muted' });
  }
  if (tool.status === 'missing_result' && title !== '无结果') {
    labels.push({ text: '无结果', tone: 'muted' });
  }
  const agent = resolveAgentLabel(input, output);
  if (agent && !title.includes(agent)) {
    labels.push({ text: truncateText(agent, TITLE_TEXT_LIMIT), tone: 'muted' });
  }
  const durationLabel = formatToolDuration(tool.durationMs);
  if (durationLabel) {
    labels.push({ text: durationLabel, tone: 'muted' });
  }
  return labels;
}

export function isAgentToolActivityTool(tool: SessionRenderToolCard): boolean {
  return resolveAgentToolKind(tool.name) !== null;
}

export const agentToolActivityRenderer = (tool: SessionRenderToolCard): ToolActivityViewModel => {
  const kind = resolveAgentToolKind(tool.name) ?? 'dispatch';
  const input = readAgentToolInput(tool);
  const output = readAgentToolOutput(tool);
  const title = resolveTitle(kind, input, output);
  const textBlocks = buildTextBlocks(kind, input, output);
  const tone = resolveToolTone(tool.status, output.status);

  return {
    title,
    tone,
    isRunning: tone === 'running',
    isError: tone === 'danger',
    canExpand: textBlocks.length > 0,
    trailingLabels: buildTrailingLabels(tool, title, input, output),
    textBlocks,
  };
};
