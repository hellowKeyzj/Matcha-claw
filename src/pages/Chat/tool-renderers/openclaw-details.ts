import type { SessionRenderToolCard } from '../../../types/session/tool-card';

export type OpenClawPublicDetailValue =
  | string
  | number
  | boolean
  | null
  | OpenClawPublicDetailValue[]
  | { [key: string]: OpenClawPublicDetailValue };

export type OpenClawPublicDetailObject = { [key: string]: OpenClawPublicDetailValue };

export interface OpenClawMcpAppPreview {
  readonly kind: 'canvas';
  readonly surface: 'assistant_message' | 'node_panel';
  readonly render: 'url';
  readonly title?: string;
  readonly preferredHeight?: number;
  readonly url?: string;
  readonly viewId?: string;
  readonly className?: string;
  readonly style?: string;
  readonly sandbox?: 'strict' | 'scripts';
  readonly boardWidgetName?: string;
  readonly mcpApp?: {
    readonly viewId: string;
    readonly serverName?: string;
    readonly toolName?: string;
    readonly uiResourceUri?: string;
    readonly toolCallId?: string;
    readonly originSessionKey?: string;
    readonly resultMetaState?: 'unavailable';
  };
}

export interface OpenClawBrowserTabPreview {
  readonly kind: 'browser-tab';
  readonly targetId: string;
  readonly profile: string;
  readonly target: 'host' | 'node';
  readonly node?: string;
  readonly title?: string;
  readonly url?: string;
}

export interface OpenClawApprovalReview {
  readonly id: string;
  readonly label: string;
  readonly status: 'in_progress' | 'approved' | 'denied' | 'timed_out' | 'aborted';
  readonly riskLevel?: string;
  readonly userAuthorization?: string;
  readonly rationale?: string;
}

export type OpenClawApprovalReviewOutcome = 'approved' | 'denied' | 'reviewing';

export interface OpenClawProgressReceipt {
  readonly total: number;
  readonly completed: number;
  readonly currentLabel?: string;
  readonly currentStatus?: 'pending' | 'in_progress' | 'completed';
  readonly markdown?: string;
}

export interface OpenClawPublicDetailSummary {
  browserTab?: OpenClawBrowserTabPreview;
  changed?: OpenClawPublicDetailValue;
  created?: OpenClawPublicDetailValue;
  diff?: OpenClawPublicDetailValue;
  patch?: OpenClawPublicDetailValue;
  approvalReviews?: OpenClawApprovalReview[];
  approvalReviewOutcome?: OpenClawApprovalReviewOutcome;
  mcpAppPreview?: OpenClawMcpAppPreview;
  truncation?: OpenClawPublicDetailValue;
  fullOutputPath?: string;
  exitCode?: number;
}

const DEFAULT_STRING_CHARS = 512;
const URL_STRING_CHARS = 2048;
const TITLE_STRING_CHARS = 512;
const ID_STRING_CHARS = 256;
const VIEW_ID_STRING_CHARS = 128;
const CLASS_NAME_STRING_CHARS = 256;
const STYLE_STRING_CHARS = 1024;
const LABEL_STRING_CHARS = 80;
const RATIONALE_STRING_CHARS = 2000;
const MARKDOWN_STRING_CHARS = 4000;
const MAX_APPROVAL_REVIEWS = 16;
const STRUCTURED_TEXT_PARSE_CHARS = 20000;
const DEFAULT_BOUNDED_DETAIL_OPTIONS = {
  maxDepth: 4,
  maxKeys: 32,
  maxArrayItems: 24,
  maxStringChars: 2000,
};
const REVIEW_STATUSES = new Set(['in_progress', 'approved', 'denied', 'timed_out', 'aborted']);
const UNSAFE_DETAIL_KEYS = new Set([
  'rawassistanttext',
  'sourcereply',
  'toolinput',
  'tooloutput',
  'toolresult',
  'html',
  'input',
  'output',
  'privatepayload',
]);
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
const BOARD_WIDGET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateUtf16Safe(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const truncated = text.slice(0, maxChars);
  const lastCode = truncated.charCodeAt(truncated.length - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

export function readBoundedString(value: unknown, maxChars = DEFAULT_STRING_CHARS): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const limit = Math.max(0, Math.trunc(maxChars));
  const text = value.trim();
  if (!text || limit <= 0 || text.includes('\0')) {
    return undefined;
  }
  return truncateUtf16Safe(text, limit);
}

export function readBoundedNumber(
  value: unknown,
  options: {
    readonly min?: number;
    readonly max?: number;
    readonly integer?: boolean;
    readonly clamp?: boolean;
  } = {},
): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) {
    return undefined;
  }
  const min = Number.isFinite(options.min) ? options.min : undefined;
  const max = Number.isFinite(options.max) ? options.max : undefined;
  if (min !== undefined && parsed < min) {
    return undefined;
  }
  const bounded = max !== undefined && parsed > max
    ? options.clamp === true ? max : undefined
    : parsed;
  if (bounded === undefined) {
    return undefined;
  }
  return options.integer === true ? Math.trunc(bounded) : bounded;
}

export function readBoundedObject(
  value: unknown,
  options: {
    readonly maxDepth?: number;
    readonly maxKeys?: number;
    readonly maxArrayItems?: number;
    readonly maxStringChars?: number;
  } = {},
): OpenClawPublicDetailObject | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const bounded = readBoundedDetailValue(value, {
    maxDepth: boundedPositiveInteger(options.maxDepth, DEFAULT_BOUNDED_DETAIL_OPTIONS.maxDepth),
    maxKeys: boundedPositiveInteger(options.maxKeys, DEFAULT_BOUNDED_DETAIL_OPTIONS.maxKeys),
    maxArrayItems: boundedPositiveInteger(options.maxArrayItems, DEFAULT_BOUNDED_DETAIL_OPTIONS.maxArrayItems),
    maxStringChars: boundedPositiveInteger(options.maxStringChars, DEFAULT_BOUNDED_DETAIL_OPTIONS.maxStringChars),
  }, 0);
  return isPublicDetailObject(bounded) ? bounded : undefined;
}

export function isOpenClawTool(tool: SessionRenderToolCard): boolean {
  return tool.runtimeAdapterId === 'openclaw';
}

export function readMcpAppPreview(details: unknown): OpenClawMcpAppPreview | undefined {
  const detailRecord = isRecord(details) ? details : undefined;
  const preview = isRecord(detailRecord?.mcpAppPreview) ? detailRecord.mcpAppPreview : undefined;
  if (!preview) {
    return undefined;
  }

  const kind = readBoundedString(preview.kind, 32)?.toLowerCase();
  if (kind && kind !== 'canvas') {
    return undefined;
  }
  const render = readBoundedString(preview.render, 32)?.toLowerCase();
  if (render && render !== 'url') {
    return undefined;
  }

  const presentation = readRecordField(preview, 'presentation');
  const view = readRecordField(preview, 'view');
  const source = readRecordField(preview, 'source');
  const surface = readCanvasSurface(preview, presentation);
  if (!surface) {
    return undefined;
  }

  const mcpApp = readMcpAppDescriptor(readRecordField(preview, 'mcpApp'));
  const title = readStringFromFields([preview, presentation, view], ['title'], TITLE_STRING_CHARS);
  const preferredHeight = readPreferredHeight(
    preview.preferredHeight,
    preview.preferred_height,
    presentation?.preferred_height,
    presentation?.preferredHeight,
    view?.preferred_height,
    view?.preferredHeight,
  );
  const url = readUrlLike(preview.url)
    ?? readUrlLike(view?.url)
    ?? readUrlLike(view?.entryUrl)
    ?? (readBoundedString(source?.type, 32)?.toLowerCase() === 'url' ? readUrlLike(source?.url) : undefined);
  const viewId = readIdentifier(preview.viewId, VIEW_ID_STRING_CHARS)
    ?? readIdentifier(view?.id, VIEW_ID_STRING_CHARS)
    ?? readIdentifier(view?.docId, VIEW_ID_STRING_CHARS)
    ?? mcpApp?.viewId;

  if (!url && !viewId) {
    return undefined;
  }

  const className = readStringFromFields([preview, presentation], ['className', 'class_name'], CLASS_NAME_STRING_CHARS);
  const style = readStringFromFields([preview, presentation], ['style'], STYLE_STRING_CHARS);
  const sandbox = readCanvasSandbox(preview.sandbox) ?? readCanvasSandbox(presentation?.sandbox);
  const boardWidgetName = readBoardWidgetName(preview.boardWidgetName) ?? readBoardWidgetName(view?.boardWidgetName);

  return {
    kind: 'canvas',
    surface,
    render: 'url',
    ...(title ? { title } : {}),
    ...(preferredHeight !== undefined ? { preferredHeight } : {}),
    ...(url ? { url } : {}),
    ...(viewId ? { viewId } : {}),
    ...(className ? { className } : {}),
    ...(style ? { style } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(boardWidgetName ? { boardWidgetName } : {}),
    ...(mcpApp ? { mcpApp } : {}),
  };
}

export function readBrowserTabPreview(details: unknown): OpenClawBrowserTabPreview | undefined {
  const detailRecord = isRecord(details) ? details : undefined;
  const tab = isRecord(detailRecord?.browserTab) ? detailRecord.browserTab : undefined;
  if (!tab) {
    return undefined;
  }
  const targetId = readIdentifier(tab.targetId, ID_STRING_CHARS);
  const profile = readIdentifier(tab.profile, ID_STRING_CHARS);
  const target = readBoundedString(tab.target, 32);
  if (!targetId || !profile) {
    return undefined;
  }
  const title = readBoundedString(tab.title, TITLE_STRING_CHARS);
  const url = readUrlLike(tab.url);
  if (target === 'host' && tab.node === undefined) {
    return { kind: 'browser-tab', targetId, profile, target, ...(title ? { title } : {}), ...(url ? { url } : {}) };
  }
  const node = target === 'node' ? readIdentifier(tab.node, ID_STRING_CHARS) : undefined;
  return node ? { kind: 'browser-tab', targetId, profile, target: 'node', node, ...(title ? { title } : {}), ...(url ? { url } : {}) } : undefined;
}

export function readApprovalReviews(details: unknown): OpenClawApprovalReview[] {
  const values = isRecord(details) ? details.approvalReviews : undefined;
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .slice(-MAX_APPROVAL_REVIEWS)
    .map(readApprovalReview)
    .filter((review): review is OpenClawApprovalReview => review !== undefined);
}

export function readApprovalReviewOutcome(details: unknown): OpenClawApprovalReviewOutcome | undefined {
  const outcome = readBoundedString(isRecord(details) ? details.approvalReviewOutcome : undefined, 32);
  return outcome === 'approved' || outcome === 'denied' || outcome === 'reviewing' ? outcome : undefined;
}

export function readProgressReceipt(tool: SessionRenderToolCard): OpenClawProgressReceipt | undefined {
  if (!isOpenClawTool(tool) || tool.name.trim().toLowerCase() !== 'progress_card') {
    return undefined;
  }
  const input = isRecord(tool.input) ? tool.input : parseJsonRecord(tool.inputText);
  if (!input) {
    return { total: 0, completed: 0 };
  }
  const steps = readProgressSteps(input.plan);
  const completed = steps.filter((step) => step.status === 'completed').length;
  const current = readCurrentProgressStep(steps);
  const markdown = readBoundedString(input.markdown, MARKDOWN_STRING_CHARS);
  return {
    total: steps.length,
    completed,
    ...(current ? { currentLabel: current.label, currentStatus: current.status } : {}),
    ...(markdown ? { markdown } : {}),
  };
}

export function readPublicDetailSummary(details: unknown): OpenClawPublicDetailSummary | undefined {
  const detailRecord = isRecord(details) ? details : undefined;
  if (!detailRecord) {
    return undefined;
  }
  const summary: OpenClawPublicDetailSummary = {};
  const browserTab = readBrowserTabPreview(detailRecord);
  const approvalReviews = readApprovalReviews(detailRecord);
  const approvalReviewOutcome = readApprovalReviewOutcome(detailRecord);
  const mcpAppPreview = readMcpAppPreview(detailRecord);
  const fullOutputPath = readBoundedString(detailRecord.fullOutputPath, URL_STRING_CHARS);
  const exitCode = readBoundedNumber(detailRecord.exitCode, {
    min: -2147483648,
    max: 2147483647,
    integer: true,
  });

  if (browserTab) {
    summary.browserTab = browserTab;
  }
  for (const key of ['changed', 'created', 'diff', 'patch', 'truncation'] as const) {
    const value = readPublicDetailValue(detailRecord[key]);
    if (hasPublicDetailContent(value)) {
      summary[key] = value;
    }
  }
  if (approvalReviews.length > 0) {
    summary.approvalReviews = approvalReviews;
  }
  if (approvalReviewOutcome) {
    summary.approvalReviewOutcome = approvalReviewOutcome;
  }
  if (mcpAppPreview) {
    summary.mcpAppPreview = mcpAppPreview;
  }
  if (fullOutputPath) {
    summary.fullOutputPath = fullOutputPath;
  }
  if (exitCode !== undefined) {
    summary.exitCode = exitCode;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function readRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readStringFromFields(
  records: ReadonlyArray<Record<string, unknown> | undefined>,
  keys: readonly string[],
  maxChars: number,
): string | undefined {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of keys) {
      const value = readBoundedString(record[key], maxChars);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readCanvasSurface(
  preview: Record<string, unknown>,
  presentation: Record<string, unknown> | undefined,
): OpenClawMcpAppPreview['surface'] | undefined {
  const surface = readBoundedString(preview.surface, 64)
    ?? readBoundedString(presentation?.target, 64)
    ?? readBoundedString(preview.target, 64)
    ?? 'assistant_message';
  return surface === 'assistant_message' || surface === 'node_panel' ? surface : undefined;
}

function readCanvasSandbox(value: unknown): OpenClawMcpAppPreview['sandbox'] | undefined {
  const sandbox = readBoundedString(value, 32);
  return sandbox === 'strict' || sandbox === 'scripts' ? sandbox : undefined;
}

function readPreferredHeight(...values: unknown[]): number | undefined {
  for (const value of values) {
    const height = readBoundedNumber(value, { min: 160, max: 1200, integer: true, clamp: true });
    if (height !== undefined) {
      return height;
    }
  }
  return undefined;
}

function readMcpAppDescriptor(
  record: Record<string, unknown> | undefined,
): OpenClawMcpAppPreview['mcpApp'] | undefined {
  const viewId = readIdentifier(record?.viewId, VIEW_ID_STRING_CHARS);
  if (!record || !viewId) {
    return undefined;
  }
  const serverName = readBoundedString(record.serverName, ID_STRING_CHARS);
  const toolName = readBoundedString(record.toolName, ID_STRING_CHARS);
  const uiResourceUri = readUiResourceUri(record.uiResourceUri);
  const toolCallId = readBoundedString(record.toolCallId, ID_STRING_CHARS);
  const originSessionKey = readBoundedString(record.originSessionKey, ID_STRING_CHARS);
  const resultMetaState = record.resultMetaState === 'unavailable' ? record.resultMetaState : undefined;
  return {
    viewId,
    ...(serverName ? { serverName } : {}),
    ...(toolName ? { toolName } : {}),
    ...(uiResourceUri ? { uiResourceUri } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(originSessionKey ? { originSessionKey } : {}),
    ...(resultMetaState ? { resultMetaState } : {}),
  };
}

function readUiResourceUri(value: unknown): string | undefined {
  const uri = readBoundedString(value, URL_STRING_CHARS);
  return uri?.startsWith('ui://') ? uri : undefined;
}

function readUrlLike(value: unknown): string | undefined {
  const url = readBoundedString(value, URL_STRING_CHARS);
  return url && !hasControlCharacter(url) ? url : undefined;
}

function readIdentifier(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string' || !value || value.length > maxChars || value.trim() !== value) {
    return undefined;
  }
  return hasControlCharacter(value) ? undefined : value;
}

function readBoardWidgetName(value: unknown): string | undefined {
  const name = readBoundedString(value, 64);
  return name && BOARD_WIDGET_NAME_PATTERN.test(name) ? name : undefined;
}

function readApprovalReview(value: unknown): OpenClawApprovalReview | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readBoundedString(value.id, ID_STRING_CHARS);
  const label = readBoundedString(value.label, LABEL_STRING_CHARS);
  const status = readBoundedString(value.status, 32);
  if (!id || !label || !isReviewStatus(status)) {
    return undefined;
  }
  const riskLevel = readBoundedString(value.riskLevel, 40);
  const userAuthorization = readBoundedString(value.userAuthorization, 40);
  const rationale = readBoundedString(value.rationale, RATIONALE_STRING_CHARS);
  return {
    id,
    label,
    status,
    ...(riskLevel ? { riskLevel } : {}),
    ...(userAuthorization ? { userAuthorization } : {}),
    ...(rationale ? { rationale } : {}),
  };
}

function isReviewStatus(value: string | undefined): value is OpenClawApprovalReview['status'] {
  return value !== undefined && REVIEW_STATUSES.has(value);
}

function parseJsonRecord(text: string | null | undefined): Record<string, unknown> | undefined {
  const trimmed = text?.trim() ?? '';
  if (!trimmed.startsWith('{') || trimmed.length > STRUCTURED_TEXT_PARSE_CHARS) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readProgressSteps(value: unknown): Array<{
  readonly label: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  const steps: Array<{ readonly label: string; readonly status: 'pending' | 'in_progress' | 'completed' }> = [];
  for (const entry of value) {
    const step = isRecord(entry) ? entry : undefined;
    const label = readBoundedString(step?.step, LABEL_STRING_CHARS);
    const status = step?.status;
    if (label && (status === 'pending' || status === 'in_progress' || status === 'completed')) {
      steps.push({ label, status });
    }
  }
  return steps;
}

function readCurrentProgressStep(
  steps: ReadonlyArray<{ readonly label: string; readonly status: 'pending' | 'in_progress' | 'completed' }>,
): { readonly label: string; readonly status: 'pending' | 'in_progress' | 'completed' } | undefined {
  const pending = steps.find((step) => step.status === 'pending');
  const inProgress = steps.find((step) => step.status === 'in_progress');
  if (inProgress ?? pending) {
    return inProgress ?? pending;
  }
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.status === 'completed') {
      return steps[index];
    }
  }
  return undefined;
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : fallback;
}

function readPublicDetailValue(value: unknown): OpenClawPublicDetailValue | undefined {
  return readBoundedDetailValue(value, DEFAULT_BOUNDED_DETAIL_OPTIONS, 0);
}

function readBoundedDetailValue(
  value: unknown,
  options: typeof DEFAULT_BOUNDED_DETAIL_OPTIONS,
  depth: number,
): OpenClawPublicDetailValue | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return readBoundedString(value, options.maxStringChars);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= options.maxDepth) {
      return undefined;
    }
    const items: OpenClawPublicDetailValue[] = [];
    for (const item of value.slice(0, options.maxArrayItems)) {
      const bounded = readBoundedDetailValue(item, options, depth + 1);
      if (bounded !== undefined) {
        items.push(bounded);
      }
    }
    return items;
  }
  if (!isRecord(value) || depth >= options.maxDepth) {
    return undefined;
  }
  const result: OpenClawPublicDetailObject = {};
  let count = 0;
  for (const [key, field] of Object.entries(value)) {
    if (count >= options.maxKeys || !isSafeDetailKey(key)) {
      continue;
    }
    const bounded = readBoundedDetailValue(field, options, depth + 1);
    if (bounded !== undefined) {
      result[key] = bounded;
      count += 1;
    }
  }
  return result;
}

function isPublicDetailObject(value: OpenClawPublicDetailValue | undefined): value is OpenClawPublicDetailObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPublicDetailContent(value: OpenClawPublicDetailValue | undefined): value is OpenClawPublicDetailValue {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(hasPublicDetailContent);
  }
  if (isPublicDetailObject(value)) {
    return Object.values(value).some(hasPublicDetailContent);
  }
  return typeof value === 'string' ? value.length > 0 : true;
}

function isSafeDetailKey(key: string): boolean {
  if (!key || key.length > 128 || key.includes('\0')) {
    return false;
  }
  const normalized = key
    .replace(/[_-]/g, '')
    .toLowerCase();
  return !UNSAFE_DETAIL_KEYS.has(normalized)
    && !normalized.startsWith('raw')
    && !normalized.startsWith('private')
    && !normalized.includes('secret');
}
