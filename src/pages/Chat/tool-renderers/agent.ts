import type { TFunction } from 'i18next';
import type { SessionRenderToolCard } from '../../../types/session/tool-card';
import type {
  ToolActivityTextBlock,
  ToolActivityTrailingLabel,
  ToolActivityContent,
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

function formatStatus(status: string, t: TFunction<'chat'>): string {
  const normalized = normalizeToolName(status);
  if (normalized === 'running' || normalized === 'inprogress' || normalized === 'pending') return t('toolStatus.running');
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'success' || normalized === 'succeeded') return t('toolActivity.agent.completed');
  if (normalized === 'failed' || normalized === 'error') return t('toolStatus.error');
  if (normalized === 'stopped' || normalized === 'cancelled' || normalized === 'canceled') return t('toolActivity.agent.stopped');
  return status;
}

function resolveAgentLabel(input: AgentToolInputFields, output: AgentToolOutputFields): string | null {
  return output.name ?? input.to ?? output.agentId ?? input.taskId ?? input.subagentType ?? null;
}

function resolveTitle(kind: AgentToolKind, input: AgentToolInputFields, output: AgentToolOutputFields, t: TFunction<'chat'>): string {
  const agent = resolveAgentLabel(input, output);

  if (kind === 'sendMessage') {
    return agent ? t('toolActivity.agent.sendTo', { name: truncateText(agent, TITLE_TEXT_LIMIT) }) : t('toolActivity.agent.send');
  }

  if (kind === 'taskOutput') {
    return t('toolActivity.agent.readOutput');
  }

  if (kind === 'taskStop') {
    return agent ? t('toolActivity.agent.stop', { name: truncateText(agent, TITLE_TEXT_LIMIT) }) : t('toolActivity.agent.stopTask');
  }

  const description = input.description ?? input.prompt ?? agent;
  return description ? t('toolActivity.agent.dispatch', { name: truncateText(description, TITLE_TEXT_LIMIT) }) : t('toolActivity.agent.dispatchTask');
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
  t: TFunction<'chat'>,
): void {
  const rows = [
    input.subagentType ? t('toolActivity.field', { label: t('toolActivity.type'), value: input.subagentType }) : null,
    input.model ? t('toolActivity.field', { label: t('toolActivity.model'), value: input.model }) : null,
    output.name ? t('toolActivity.field', { label: t('toolActivity.name'), value: output.name }) : null,
    output.agentId ? t('toolActivity.field', { label: t('toolActivity.agent.agent'), value: output.agentId }) : null,
    input.taskId ? t('toolActivity.field', { label: t('toolActivity.agent.task'), value: input.taskId }) : null,
    input.to ? t('toolActivity.field', { label: t('toolActivity.target'), value: input.to }) : null,
  ].filter((row): row is string => row !== null);

  if (rows.length === 0) return;
  addTextBlock(textBlocks, 'notice', t('toolActivity.agent.info'), rows.join('\n'));
}

function buildTextBlocks(
  kind: AgentToolKind,
  input: AgentToolInputFields,
  output: AgentToolOutputFields,
  t: TFunction<'chat'>,
): ToolActivityTextBlock[] {
  const textBlocks: ToolActivityTextBlock[] = [];

  if (kind === 'sendMessage') {
    addTextBlock(textBlocks, 'input', t('toolActivity.agent.message'), input.message);
  } else if (kind === 'dispatch') {
    addTextBlock(textBlocks, 'input', t('toolActivity.agent.description'), input.description);
    addTextBlock(textBlocks, 'input', t('toolActivity.target'), input.prompt);
  }

  addInfoBlock(textBlocks, input, output, t);
  addTextBlock(textBlocks, 'output', t('toolActivity.resultSummary'), output.summary);
  if (output.result !== output.summary) {
    addTextBlock(textBlocks, 'output', t('toolActivity.result'), output.result);
  }
  if (output.status && !output.summary && !output.result) {
    addTextBlock(textBlocks, 'notice', t('toolActivity.status'), formatStatus(output.status, t));
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

export const agentToolActivityRenderer = (tool: SessionRenderToolCard, t: TFunction<'chat'>): ToolActivityContent => {
  const kind = resolveAgentToolKind(tool.name) ?? 'dispatch';
  const input = readAgentToolInput(tool);
  const output = readAgentToolOutput(tool);
  const title = resolveTitle(kind, input, output, t);
  const textBlocks = buildTextBlocks(kind, input, output, t);

  return {
    title,
    hasOutputError: ['failed', 'error'].includes(normalizeToolName(output.status ?? '')),
    canExpand: textBlocks.length > 0,
    trailingLabels: buildTrailingLabels(tool, title, input, output),
    textBlocks,
  };
};
