import type { SessionRenderToolCard, SessionRenderToolStatusKind } from '../../../types/session/tool-card';
import type {
  ToolActivityTextBlock,
  ToolActivityTone,
  ToolActivityTrailingLabel,
  ToolActivityViewModel,
} from '../tool-activity-view-model';
import { extractToolResultContentBlockText, parseToolResultJson } from './result-content';

export const skillToolActivityToolNames = [
  'Skill',
  'SlashCommand',
  'CommandLoader',
  'LoadSkill',
] as const;

type SkillToolMode = 'skill' | 'command';

type SkillToolRecord = Record<string, unknown>;

interface SkillToolRequest {
  mode: SkillToolMode;
  skillName: string | null;
  command: string | null;
  args: unknown;
}

interface SkillToolOutputSummary {
  status: string | null;
  allowedTools: string[] | null;
  model: string | null;
  message: string | null;
}

const COVERED_TOOL_NAMES = new Set(skillToolActivityToolNames.map(normalizeToolName));
const COMMAND_TOOL_NAMES = new Set(['slashcommand', 'commandloader', 'command']);
const SKILL_TOOL_NAMES = new Set(['skill', 'loadskill']);

function isRecord(value: unknown): value is SkillToolRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizeToolName(name: string): string {
  return name.replace(/[\s_-]/gu, '').toLowerCase();
}

function parseStructuredText(text?: string): unknown {
  return parseToolResultJson(text);
}

function readStringField(records: ReadonlyArray<SkillToolRecord>, keys: ReadonlyArray<string>): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }
  return null;
}

function readField(records: ReadonlyArray<SkillToolRecord>, keys: ReadonlyArray<string>): unknown {
  for (const record of records) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        return record[key];
      }
    }
  }
  return undefined;
}

function collectInputRecords(tool: SessionRenderToolCard): SkillToolRecord[] {
  const records: SkillToolRecord[] = [];
  if (isRecord(tool.input)) {
    records.push(tool.input);
  }
  const parsedInputText = parseStructuredText(tool.inputText);
  if (isRecord(parsedInputText)) {
    records.push(parsedInputText);
  }
  return records;
}

function collectOutputRecords(tool: SessionRenderToolCard): SkillToolRecord[] {
  const records: SkillToolRecord[] = [];
  if (isRecord(tool.output)) {
    records.push(tool.output);
  }
  const parsedResult = parseStructuredText(readResultText(tool));
  if (isRecord(parsedResult)) {
    records.push(parsedResult);
  }
  return records;
}

function readResultText(tool: SessionRenderToolCard): string {
  if (tool.result.kind === 'text' || tool.result.kind === 'json') {
    return tool.result.bodyText.trim();
  }
  if (tool.result.kind === 'canvas') {
    return tool.result.rawText?.trim() ?? '';
  }
  return '';
}

function readPlainResultMessage(tool: SessionRenderToolCard): string | null {
  const outputText = extractToolResultContentBlockText(tool.output);
  if (outputText) {
    return truncateText(outputText, 320);
  }

  const text = readResultText(tool);
  const contentBlockText = extractToolResultContentBlockText(parseToolResultJson(text));
  if (contentBlockText) {
    return truncateText(contentBlockText, 320);
  }

  if (tool.result.kind === 'json') {
    return null;
  }
  if (!text || text.startsWith('{') || text.startsWith('[')) {
    return null;
  }
  return truncateText(text, 320);
}

function resolveRequest(tool: SessionRenderToolCard): SkillToolRequest {
  const inputRecords = collectInputRecords(tool);
  const normalizedName = normalizeToolName(tool.name);
  const skillName = readStringField(inputRecords, ['skill', 'name']);
  const command = readStringField(inputRecords, ['command']);
  const mode: SkillToolMode = command || COMMAND_TOOL_NAMES.has(normalizedName)
    ? 'command'
    : 'skill';

  return {
    mode,
    skillName: mode === 'skill' ? skillName : null,
    command: mode === 'command' ? command ?? skillName : null,
    args: readField(inputRecords, ['args']),
  };
}

function resolveOutputSummary(tool: SessionRenderToolCard): SkillToolOutputSummary {
  const outputRecords = collectOutputRecords(tool);
  return {
    status: readStringField(outputRecords, ['status', 'state']),
    allowedTools: readAllowedTools(outputRecords),
    model: readStringField(outputRecords, ['model']),
    message: readStringField(outputRecords, ['message', 'summary']) ?? readPlainResultMessage(tool),
  };
}

function readAllowedTools(records: ReadonlyArray<SkillToolRecord>): string[] | null {
  const value = readField(records, ['allowedTools', 'allowed_tools', 'tools']);
  if (isStringArray(value)) {
    return value.map((tool) => tool.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    const names = value
      .map((item) => (isRecord(item) ? readStringField([item], ['name']) : null))
      .filter((item): item is string => item != null);
    return names.length > 0 ? names : null;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((tool) => tool.trim()).filter(Boolean);
  }
  return null;
}

function formatCommandForTitle(command: string | null): string {
  const fallback = 'command';
  const firstToken = (command?.trim() ?? '').split(/\s+/u).filter(Boolean)[0] ?? fallback;
  return firstToken.startsWith('/') ? firstToken : `/${firstToken}`;
}

function formatSkillName(skillName: string | null): string {
  return skillName?.trim() || '未知';
}

function buildTitle(request: SkillToolRequest): string {
  if (request.mode === 'command') {
    return `运行 ${formatCommandForTitle(request.command)}`;
  }
  return `加载 skill ${formatSkillName(request.skillName)}`;
}

function resolveTone(status: SessionRenderToolStatusKind): ToolActivityTone {
  if (status === 'running') return 'running';
  if (status === 'error') return 'danger';
  if (status === 'missing_result') return 'muted';
  return 'neutral';
}

function formatStatusLabel(
  request: SkillToolRequest,
  output: SkillToolOutputSummary,
  toolStatus: SessionRenderToolStatusKind,
): string {
  if (toolStatus === 'running') return '运行中';
  if (toolStatus === 'error') return '失败';
  if (toolStatus === 'missing_result') return '无结果';

  const normalizedStatus = output.status?.toLowerCase() ?? '';
  if (normalizedStatus === 'error' || normalizedStatus === 'failed' || normalizedStatus === 'failure') return '失败';
  if (normalizedStatus === 'running' || normalizedStatus === 'loading') return '运行中';

  return request.mode === 'command' ? '已运行' : '已加载';
}

function buildByline(
  request: SkillToolRequest,
  output: SkillToolOutputSummary,
  toolStatus: SessionRenderToolStatusKind,
): string {
  const parts = [formatStatusLabel(request, output, toolStatus)];
  if (output.allowedTools) {
    parts.push(`${output.allowedTools.length} tools`);
  }
  if (output.model) {
    parts.push(output.model);
  }
  return parts.join(' · ');
}

function truncateText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatPrimitive(value: string | number | boolean): string {
  return typeof value === 'string' ? truncateText(value, 240) : String(value);
}

function formatValueSummary(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (isPrimitive(value)) {
    const formatted = formatPrimitive(value);
    return formatted || null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '空';
    }
    if (value.every(isPrimitive)) {
      return truncateText(value.map(formatPrimitive).join(' '), 240);
    }
    return `${value.length} 项`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).slice(0, 8).map(([key, entryValue]) => {
      if (isPrimitive(entryValue)) {
        return `${key}=${formatPrimitive(entryValue)}`;
      }
      if (Array.isArray(entryValue)) {
        return `${key}=${entryValue.length} 项`;
      }
      if (isRecord(entryValue)) {
        return `${key}=对象`;
      }
      return `${key}=空`;
    });
    return entries.length > 0 ? truncateText(entries.join(', '), 240) : '空';
  }
  return null;
}

function buildParameterText(request: SkillToolRequest): string {
  const lines: string[] = [];
  if (request.mode === 'command') {
    lines.push(`command: ${formatCommandForTitle(request.command)}`);
  } else {
    lines.push(`skill: ${formatSkillName(request.skillName)}`);
  }

  const argsSummary = formatValueSummary(request.args);
  if (argsSummary) {
    lines.push(`args: ${argsSummary}`);
  }

  return lines.join('\n');
}

function formatAllowedToolsList(tools: ReadonlyArray<string>): string {
  if (tools.length === 0) {
    return '0 tools';
  }
  const visibleTools = tools.slice(0, 8).join(', ');
  return tools.length > 8 ? `${visibleTools} +${tools.length - 8}` : visibleTools;
}

function buildResultText(
  request: SkillToolRequest,
  output: SkillToolOutputSummary,
  toolStatus: SessionRenderToolStatusKind,
): string {
  const lines = [`status: ${formatStatusLabel(request, output, toolStatus)}`];
  if (output.allowedTools) {
    lines.push(`allowedTools: ${formatAllowedToolsList(output.allowedTools)}`);
  }
  if (output.model) {
    lines.push(`model: ${output.model}`);
  }
  if (output.message) {
    lines.push(`message: ${truncateText(output.message, 320)}`);
  }
  return lines.join('\n');
}

function buildTextBlocks(
  request: SkillToolRequest,
  output: SkillToolOutputSummary,
  toolStatus: SessionRenderToolStatusKind,
): ToolActivityTextBlock[] {
  return [
    {
      kind: 'input',
      title: '参数',
      text: buildParameterText(request),
      copyable: true,
    },
    {
      kind: 'output',
      title: request.mode === 'command' ? '运行结果' : '加载结果',
      text: buildResultText(request, output, toolStatus),
      copyable: false,
    },
  ];
}

export function isSkillToolActivity(tool: SessionRenderToolCard): boolean {
  const normalizedName = normalizeToolName(tool.name);
  return COVERED_TOOL_NAMES.has(normalizedName)
    || COMMAND_TOOL_NAMES.has(normalizedName)
    || SKILL_TOOL_NAMES.has(normalizedName);
}

export function skillToolActivityRenderer(tool: SessionRenderToolCard): ToolActivityViewModel {
  const request = resolveRequest(tool);
  const output = resolveOutputSummary(tool);
  const title = buildTitle(request);
  const trailingLabels: ToolActivityTrailingLabel[] = [
    { text: buildByline(request, output, tool.status), tone: 'muted' },
  ];

  return {
    title,
    tone: resolveTone(tool.status),
    isRunning: tool.status === 'running',
    isError: tool.status === 'error',
    canExpand: true,
    trailingLabels,
    textBlocks: buildTextBlocks(request, output, tool.status),
  };
}
