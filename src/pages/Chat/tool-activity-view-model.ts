import type {
  SessionRenderAssistantBubbleToolResult,
  SessionRenderToolCard,
  SessionRenderToolStatusKind,
} from '../../types/session/tool-card';

export type ToolActivityTone = 'neutral' | 'running' | 'danger' | 'muted';

export interface ToolActivityTrailingLabel {
  text: string;
  tone: 'neutral' | 'muted';
}

export interface ToolActivityTextBlock {
  kind: 'input' | 'output' | 'notice';
  title?: string;
  text: string;
  copyable: boolean;
}

export interface ToolActivityViewModel {
  title: string;
  tone: ToolActivityTone;
  isRunning: boolean;
  isError: boolean;
  canExpand: boolean;
  trailingLabels: ToolActivityTrailingLabel[];
  textBlocks: ToolActivityTextBlock[];
  canvasPreview?: {
    title: string;
    url: string;
    preferredHeight?: number;
    rawText?: string;
  };
}

const NON_ACTIVITY_TITLE_TEXT = new Set([
  '失败',
  '错误',
  '运行中',
  '完成',
  '无结果',
  'failed',
  'error',
  'running',
  'completed',
  'missing result',
]);

function formatToolDuration(durationMs?: number): string | null {
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'string' && field.trim()) {
      return field.trim();
    }
  }
  return null;
}

function parseStructuredInputText(inputText: string): unknown {
  const trimmed = inputText.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function readToolCommand(input: unknown, inputText: string): string {
  const field = readStringField(input, ['command', 'cmd', 'script', 'code', 'query']);
  if (field) {
    return field;
  }
  return readStringField(parseStructuredInputText(inputText), ['command', 'cmd', 'script', 'code', 'query']) ?? inputText;
}

function isMeaningfulActivityText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.length > 0 && !NON_ACTIVITY_TITLE_TEXT.has(normalized);
}

function isMeaningfulToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'tool' && !NON_ACTIVITY_TITLE_TEXT.has(normalized);
}

function resolveToolLanguageLabel(toolName: string, command: string): string {
  const name = toolName.trim();
  if (/powershell|pwsh/i.test(name) || /\b(powershell|pwsh)\b/i.test(command)) return 'PowerShell';
  if (/python/i.test(name) || /\bpython3?\b/i.test(command)) return 'Python';
  if (/node|javascript|typescript/i.test(name) || /\b(node|npm|pnpm|bun)\b/i.test(command)) return 'Node';
  if (/bash|shell|terminal/i.test(name) || /\b(bash|sh|zsh|fish)\b/i.test(command)) return 'Shell';
  if (/web|search/i.test(name)) return 'Web';
  return isMeaningfulToolName(name) ? name : 'Tool';
}

function resolveActivityTitle(input: {
  primaryTitle: string;
  detailTitle: string;
  summary?: string;
  command: string;
  languageLabel: string;
}): string {
  const detailTitle = input.detailTitle.trim();
  if (detailTitle !== input.primaryTitle && isMeaningfulActivityText(detailTitle)) {
    return detailTitle;
  }

  const summary = input.summary?.trim() ?? '';
  if (summary.length <= 96 && isMeaningfulActivityText(summary)) {
    return summary;
  }

  if (input.command && input.languageLabel !== 'Tool') {
    return `运行 ${input.languageLabel}`;
  }

  if (isMeaningfulToolName(input.primaryTitle)) {
    return `调用 ${input.primaryTitle.trim()}`;
  }

  return '工具调用';
}

function resolveToolTone(status: SessionRenderToolStatusKind): ToolActivityTone {
  if (status === 'running') return 'running';
  if (status === 'error') return 'danger';
  if (status === 'missing_result') return 'muted';
  return 'neutral';
}

function buildTrailingLabels(tool: SessionRenderToolCard, title: string): ToolActivityTrailingLabel[] {
  const labels: ToolActivityTrailingLabel[] = [];
  if (tool.status === 'running' && title !== '运行中') {
    labels.push({ text: '运行中', tone: 'muted' });
  }
  if (tool.status === 'missing_result' && title !== '无结果') {
    labels.push({ text: '无结果', tone: 'muted' });
  }
  const durationLabel = formatToolDuration(tool.durationMs);
  if (durationLabel) {
    labels.push({ text: durationLabel, tone: 'muted' });
  }
  return labels;
}

export function buildToolActivityViewModel(tool: SessionRenderToolCard): ToolActivityViewModel {
  const inputText = tool.inputText?.trim() ?? '';
  const result = tool.result;
  const command = readToolCommand(tool.input, inputText).trim();
  const outputPreview = (
    result.kind === 'text' || result.kind === 'json' || result.kind === 'canvas'
  ) ? result.collapsedPreview.trim() : '';
  const outputText = result.kind === 'text' || result.kind === 'json'
    ? result.bodyText.trim()
    : result.kind === 'canvas' ? result.rawText?.trim() ?? '' : '';
  const primaryTitle = tool.displayTitle?.trim() || tool.name?.trim() || '';
  const languageLabel = resolveToolLanguageLabel(tool.name || primaryTitle, command);
  const title = resolveActivityTitle({
    primaryTitle,
    detailTitle: tool.displayDetail?.trim() ?? '',
    summary: tool.summary,
    command,
    languageLabel,
  });
  const hasAssistantCanvas = result.kind === 'canvas' && result.preview.kind === 'canvas' && !!result.preview.url;
  const canvasPreview = hasAssistantCanvas
    ? {
      title: result.preview.title?.trim() || tool.name || title,
      url: result.preview.url,
      preferredHeight: result.preview.preferredHeight,
      rawText: result.rawText?.trim() || undefined,
    }
    : undefined;
  const textBlocks: ToolActivityTextBlock[] = [];
  if (command) {
    textBlocks.push({
      kind: 'input',
      title: languageLabel,
      text: command,
      copyable: true,
    });
  }
  if (hasAssistantCanvas) {
    textBlocks.push({
      kind: 'notice',
      text: '预览已显示在助手消息里。',
      copyable: false,
    });
  }
  if (outputText || outputPreview) {
    textBlocks.push({
      kind: 'output',
      text: outputText || outputPreview,
      copyable: false,
    });
  }

  return {
    title,
    tone: resolveToolTone(tool.status),
    isRunning: tool.status === 'running',
    isError: tool.status === 'error',
    canExpand: textBlocks.length > 0 || canvasPreview != null,
    trailingLabels: buildTrailingLabels(tool, title),
    textBlocks,
    canvasPreview,
  };
}

export function buildCanvasActivityViewModel(item: SessionRenderAssistantBubbleToolResult): ToolActivityViewModel | null {
  if (item.preview.kind !== 'canvas') {
    return null;
  }

  const rawText = item.rawText?.trim() ?? '';
  return {
    title: item.preview.title?.trim() || item.toolName,
    tone: 'neutral',
    isRunning: false,
    isError: false,
    canExpand: rawText.length > 0,
    trailingLabels: [{ text: '画布', tone: 'muted' }],
    textBlocks: rawText ? [{ kind: 'output', text: rawText, copyable: false }] : [],
    canvasPreview: {
      title: item.preview.title?.trim() || item.toolName,
      url: item.preview.url,
      preferredHeight: item.preview.preferredHeight,
      rawText: rawText || undefined,
    },
  };
}
