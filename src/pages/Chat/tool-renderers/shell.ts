import type { SessionRenderToolCard } from '../../../types/session/tool-card';
import type { ToolActivityTextBlock, ToolActivityTone, ToolActivityTrailingLabel, ToolActivityViewModel } from '../tool-activity-view-model';
import { extractToolResultContentBlockText } from './result-content';

const SHELL_TOOL_NAME_PATTERN = /^(bash|shell|powershell|pwsh|terminal|command|exec|runcommand|run_command|run-command|run command|cmd|sh)$/i;
const COMMAND_KEYS = ['command', 'cmd', 'script', 'code', 'query'];
const OUTPUT_TEXT_LIMIT = 12000;
const TITLE_COMMAND_LIMIT = 72;
const BODY_PREVIEW_LIMIT = 240;

type JsonRecord = Record<string, unknown>;

interface ParsedShellOutput {
  stdout?: string;
  stderr?: string;
  exitCode?: number | string;
  status?: string;
  signal?: string;
  durationMs?: number;
  fallbackText?: string;
  isTruncated?: boolean;
  fullOutputPath?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShellOutput(value: unknown): value is ParsedShellOutput {
  if (!isRecord(value)) {
    return false;
  }
  return ['stdout', 'stderr', 'exitCode', 'code', 'status', 'signal', 'durationMs', 'duration_ms'].some((key) => key in value);
}

function parseJsonValue(text: string | null | undefined): unknown {
  const trimmed = text?.trim() ?? '';
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): JsonRecord | null {
  const parsed = parseJsonValue(text);
  return isRecord(parsed) ? parsed : null;
}

function readStringField(input: unknown, keys: ReadonlyArray<string>): string | null {
  if (!isRecord(input)) {
    return null;
  }
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function readNumberField(input: unknown, keys: ReadonlyArray<string>): number | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function readExitCode(input: unknown): number | string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const exitCode = input.exitCode ?? input.code;
  if (typeof exitCode === 'number' && Number.isFinite(exitCode)) {
    return exitCode;
  }
  if (typeof exitCode === 'string' && exitCode.trim()) {
    const trimmed = exitCode.trim();
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : trimmed;
  }
  return undefined;
}

function readToolDetails(tool: SessionRenderToolCard): JsonRecord | null {
  const details = (tool as SessionRenderToolCard & { details?: unknown }).details;
  return isRecord(details) ? details : null;
}

function hasTruncation(details: JsonRecord | null): boolean {
  if (!details || !('truncation' in details)) {
    return false;
  }
  const truncation = details.truncation;
  if (typeof truncation === 'boolean') {
    return truncation;
  }
  if (typeof truncation === 'string') {
    const normalized = truncation.trim().toLowerCase();
    return normalized.length > 0 && normalized !== 'false';
  }
  return truncation !== null && truncation !== undefined;
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit).trimEnd()}…`;
}

function readCommand(tool: SessionRenderToolCard): string {
  const inputText = tool.inputText?.trim() ?? '';
  return readStringField(tool.input, COMMAND_KEYS)
    ?? readStringField(parseJsonObject(inputText), COMMAND_KEYS)
    ?? inputText;
}

function shellLabel(toolName: string, command: string): string {
  if (/powershell|pwsh/i.test(toolName) || /\b(powershell|pwsh)\b/i.test(command)) return 'PowerShell';
  if (/\bpython3?\b/i.test(toolName) || /\bpython3?\b/i.test(command)) return 'Python';
  if (/\b(node|npm|pnpm|bun)\b/i.test(toolName) || /\b(node|npm|pnpm|bun)\b/i.test(command)) return 'Node';
  return 'Shell';
}

function titleFromCommand(command: string, label: string): string {
  const summary = truncateText(compactWhitespace(command), TITLE_COMMAND_LIMIT);
  if (summary) {
    return summary;
  }
  return `运行 ${label}`;
}

function resultBodyText(tool: SessionRenderToolCard): string {
  const { result } = tool;
  if (result.kind === 'text' || result.kind === 'json') {
    return result.bodyText.trim() || result.collapsedPreview.trim();
  }
  if (result.kind === 'canvas') {
    return result.rawText?.trim() ?? result.collapsedPreview.trim();
  }
  return '';
}

function resultText(tool: SessionRenderToolCard): string {
  const outputText = extractToolResultContentBlockText(tool.output);
  if (outputText) {
    return outputText;
  }

  const bodyText = resultBodyText(tool);
  const contentBlockText = extractToolResultContentBlockText(parseJsonValue(bodyText));
  return contentBlockText ?? bodyText;
}

function parseShellOutput(tool: SessionRenderToolCard): ParsedShellOutput {
  const details = readToolDetails(tool);
  const bodyText = resultText(tool);
  const parsedBody = parseJsonObject(bodyText);
  const source = isShellOutput(tool.output) ? tool.output : isShellOutput(parsedBody) ? parsedBody : null;
  const exitCode = readExitCode(details) ?? readExitCode(source);
  const isTruncated = hasTruncation(details);
  const fullOutputPath = readStringField(details, ['fullOutputPath', 'full_output_path']) ?? undefined;

  if (!source) {
    return {
      exitCode,
      fallbackText: truncateText(bodyText, BODY_PREVIEW_LIMIT),
      isTruncated,
      fullOutputPath,
    };
  }

  const stdout = readStringField(source, ['stdout']);
  const stderr = readStringField(source, ['stderr']);
  return {
    stdout: stdout ? truncateText(stdout, OUTPUT_TEXT_LIMIT) : undefined,
    stderr: stderr ? truncateText(stderr, OUTPUT_TEXT_LIMIT) : undefined,
    exitCode,
    status: readStringField(source, ['status']) ?? undefined,
    signal: readStringField(source, ['signal']) ?? undefined,
    durationMs: readNumberField(source, ['durationMs', 'duration_ms']),
    fallbackText: !stdout && !stderr ? truncateText(bodyText, BODY_PREVIEW_LIMIT) : undefined,
    isTruncated,
    fullOutputPath,
  };
}

function formatDuration(durationMs?: number): string | null {
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function isNonZeroExitCode(exitCode: number | string | undefined): boolean {
  if (typeof exitCode === 'number') return exitCode !== 0;
  if (typeof exitCode === 'string') {
    const numeric = Number(exitCode);
    return Number.isFinite(numeric) && numeric !== 0;
  }
  return false;
}

function resolveTone(tool: SessionRenderToolCard, output: ParsedShellOutput): ToolActivityTone {
  if (tool.status === 'running') return 'running';
  if (tool.status === 'error') return 'danger';
  if (tool.status === 'missing_result') return 'muted';
  if (isNonZeroExitCode(output.exitCode)) return 'danger';
  return 'neutral';
}

function resolveError(tool: SessionRenderToolCard, output: ParsedShellOutput): boolean {
  return tool.status === 'error' || isNonZeroExitCode(output.exitCode);
}

function buildTrailingLabels(tool: SessionRenderToolCard, output: ParsedShellOutput): ToolActivityTrailingLabel[] {
  const labels: ToolActivityTrailingLabel[] = [];
  if (tool.status === 'running') {
    labels.push({ text: '运行中', tone: 'muted' });
  }
  if (output.exitCode !== undefined) {
    labels.push({ text: `exit ${output.exitCode}`, tone: 'muted' });
  }
  if (output.status) {
    labels.push({ text: output.status, tone: 'muted' });
  }
  if (output.signal) {
    labels.push({ text: `signal ${output.signal}`, tone: 'muted' });
  }
  const duration = formatDuration(output.durationMs ?? tool.durationMs);
  if (duration) {
    labels.push({ text: duration, tone: 'muted' });
  }
  return labels;
}

function buildDetailsBlock(output: ParsedShellOutput): ToolActivityTextBlock | null {
  const lines: string[] = [];
  if (output.isTruncated) {
    lines.push('输出已截断。');
  }
  if (output.fullOutputPath) {
    lines.push(`完整输出：${output.fullOutputPath}`);
  }
  if (!lines.length) {
    return null;
  }
  return {
    kind: 'notice',
    title: output.isTruncated ? '输出详情' : '完整输出',
    text: lines.join('\n'),
    copyable: false,
  };
}

function buildTextBlocks(command: string, label: string, output: ParsedShellOutput): ToolActivityTextBlock[] {
  const blocks: ToolActivityTextBlock[] = [];
  if (command.trim()) {
    blocks.push({
      kind: 'input',
      title: `${label} 命令`,
      text: command.trim(),
      copyable: true,
    });
  }
  if (output.stdout) {
    blocks.push({
      kind: 'output',
      title: 'stdout',
      text: output.stdout,
      copyable: false,
    });
  }
  if (output.stderr) {
    blocks.push({
      kind: 'notice',
      title: 'stderr',
      text: output.stderr,
      copyable: false,
    });
  }
  if (!output.stdout && !output.stderr && output.fallbackText) {
    blocks.push({
      kind: 'output',
      title: '输出',
      text: output.fallbackText,
      copyable: false,
    });
  }
  if (isNonZeroExitCode(output.exitCode)) {
    blocks.push({
      kind: 'notice',
      title: '退出码',
      text: `exit ${output.exitCode}`,
      copyable: false,
    });
  }
  const detailsBlock = buildDetailsBlock(output);
  if (detailsBlock) {
    blocks.push(detailsBlock);
  }
  return blocks;
}

export function isShellToolCard(tool: SessionRenderToolCard): boolean {
  return SHELL_TOOL_NAME_PATTERN.test(tool.name.trim()) || SHELL_TOOL_NAME_PATTERN.test(tool.displayTitle.trim());
}

export function shellToolActivityRenderer(tool: SessionRenderToolCard): ToolActivityViewModel {
  const command = readCommand(tool).trim();
  const label = shellLabel(`${tool.name} ${tool.displayTitle}`, command);
  const output = parseShellOutput(tool);
  const textBlocks = buildTextBlocks(command, label, output);

  return {
    title: titleFromCommand(command, label),
    tone: resolveTone(tool, output),
    isRunning: tool.status === 'running',
    isError: resolveError(tool, output),
    canExpand: textBlocks.length > 0,
    trailingLabels: buildTrailingLabels(tool, output),
    textBlocks,
  };
}
