import type { TFunction } from 'i18next';
import type {
  SessionRenderAssistantBubbleToolResult,
  SessionRenderToolCard,
} from '../../types/session/tool-card';
import { buildToolActivityPreview as buildPreviewFromRegistry, buildToolActivityViewModelFromRegistry } from './tool-renderers';
import { isOpenClawTool, readMcpAppPreview, type OpenClawMcpAppPreview } from './tool-renderers/openclaw-details';
import { isOpenClawSurfaceSessionIdentity, type OpenClawRuntimeSurfaceDescriptor } from '../../types/openclaw-runtime-surface';
import type { SessionIdentity } from '../../types/desktop/runtime-address';
import type {
  OpenClawApprovalReview,
  OpenClawApprovalReviewOutcome,
  OpenClawBrowserTabPreview,
  OpenClawPublicDetailValue,
} from './tool-renderers/openclaw-details';

export { describeToolActivity, summarizeToolActivities } from './tool-renderers';

export type ToolActivityTone = 'neutral' | 'running' | 'danger' | 'muted';
export type ToolActivityMetadataValue = string | number | boolean;
export type ToolActivityPublicDetailValue = OpenClawPublicDetailValue;

export interface ToolActivityTrailingLabel {
  text: string;
  tone: 'neutral' | 'muted';
}

export interface ToolActivityTextBlock {
  kind: 'input' | 'output' | 'notice' | 'details';
  title?: string;
  text: string;
  copyable: boolean;
  format?: 'command' | 'diff' | 'json';
}

export type ToolActivityBrowserTabPreview = OpenClawBrowserTabPreview;
export type ToolActivityApprovalReview = OpenClawApprovalReview;

export interface ToolActivityApprovalReviewOutcome {
  label: string;
  status: OpenClawApprovalReviewOutcome;
}

export interface ToolActivityProgressReceipt {
  completedCount: number;
  totalCount: number;
  currentItem?: string;
  currentStatus?: 'pending' | 'in_progress' | 'completed';
  markdownSummary?: string;
}

export interface ToolActivityDiffStat {
  filesChanged?: string[];
  filesCreated?: string[];
  additions?: number;
  deletions?: number;
  fileCount?: number;
}

export interface ToolActivityViewModel {
  title: string;
  tone: ToolActivityTone;
  isRunning: boolean;
  isError: boolean;
  canExpand: boolean;
  canOpenSurface?: boolean;
  trailingLabels: ToolActivityTrailingLabel[];
  textBlocks: ToolActivityTextBlock[];
  parameters?: ReadonlyArray<{ name: string; value: string }>;
  canvasPreview?: {
    title: string;
    runtimeSurface?: OpenClawRuntimeSurfaceDescriptor;
    surface?: 'assistant_message' | 'node_panel';
    sandbox?: 'strict' | 'scripts';
    boardWidgetName?: string;
    preferredHeight?: number;
    rawText?: string;
  };
  browserTabPreview?: ToolActivityBrowserTabPreview;
  approvalReviews?: ToolActivityApprovalReview[];
  approvalReviewOutcome?: ToolActivityApprovalReviewOutcome;
  progressReceipt?: ToolActivityProgressReceipt;
  publicDetails?: Record<string, ToolActivityPublicDetailValue>;
  diffStatPlacement?: 'header';
  diffStat?: ToolActivityDiffStat;
  liveDiffStat?: ToolActivityDiffStat;
}

export type ToolActivityContent = Omit<ToolActivityViewModel, 'tone' | 'isRunning' | 'isError'> & {
  hasOutputError?: boolean;
};

export function buildToolRuntimeSurface(
  tool: SessionRenderToolCard,
  sessionIdentity?: SessionIdentity,
): OpenClawRuntimeSurfaceDescriptor | undefined {
  if (!isOpenClawTool(tool) || !isOpenClawSurfaceSessionIdentity(sessionIdentity)) return undefined;
  const preview = readMcpAppPreview(tool.details);
  return preview ? bindRuntimeSurface(preview, sessionIdentity, tool.toolCallId) : undefined;
}

function bindRuntimeSurface(
  preview: OpenClawMcpAppPreview,
  sessionIdentity: SessionIdentity,
  toolCallId?: string,
): OpenClawRuntimeSurfaceDescriptor | undefined {
  const title = preview.title ? { title: preview.title } : {};
  if (preview.kind === 'canvas') return {
    kind: 'canvas', sessionIdentity, documentId: preview.documentId, ...title,
    ...(preview.sandbox ? { sandbox: preview.sandbox } : {}),
  };
  const { mcpApp } = preview;
  if ((mcpApp.originSessionKey !== undefined && mcpApp.originSessionKey !== sessionIdentity.sessionKey)
    || (mcpApp.toolCallId !== undefined && mcpApp.toolCallId !== toolCallId)) return undefined;
  return {
    kind: 'mcp-app', sessionIdentity, viewId: preview.viewId, ...title,
    ...(mcpApp.expiresAtMs !== undefined ? { expiresAtMs: mcpApp.expiresAtMs } : {}),
    ...(mcpApp.readOnly !== undefined ? { readOnly: mcpApp.readOnly } : {}),
  };
}

function withRuntimeSurface(activity: ToolActivityViewModel, tool: SessionRenderToolCard, sessionIdentity?: SessionIdentity): ToolActivityViewModel {
  if (!isOpenClawTool(tool)) return activity;
  const runtimeSurface = buildToolRuntimeSurface(tool, sessionIdentity);
  return {
    ...activity,
    canOpenSurface: runtimeSurface !== undefined || (activity.browserTabPreview !== undefined && isOpenClawSurfaceSessionIdentity(sessionIdentity)),
    ...(activity.canvasPreview ? { canvasPreview: { ...activity.canvasPreview, runtimeSurface } } : {}),
  };
}

export function buildToolActivityPreview(tool: SessionRenderToolCard, t: TFunction<'chat'>, sessionIdentity?: SessionIdentity): ToolActivityViewModel | null {
  const preview = buildPreviewFromRegistry(tool, t);
  return preview ? withRuntimeSurface(preview, tool, sessionIdentity) : null;
}

export function buildToolActivityViewModel(tool: SessionRenderToolCard, t: TFunction<'chat'>, sessionIdentity?: SessionIdentity): ToolActivityViewModel {
  return withRuntimeSurface(buildToolActivityViewModelFromRegistry(tool, t), tool, sessionIdentity);
}

export function buildCanvasActivityViewModel(item: SessionRenderAssistantBubbleToolResult, t: TFunction<'chat'>, tool?: SessionRenderToolCard, sessionIdentity?: SessionIdentity): ToolActivityViewModel | null {
  if (item.preview.kind !== 'canvas') {
    return null;
  }

  const rawText = item.rawText?.trim() ?? '';
  const preview = tool && isOpenClawTool(tool) ? readMcpAppPreview(tool.details) : undefined;
  const runtimeSurface = tool ? buildToolRuntimeSurface(tool, sessionIdentity) : undefined;
  const title = preview?.title ?? (item.preview.title?.trim() || item.toolName);
  return {
    title,
    tone: 'neutral',
    isRunning: false,
    isError: false,
    canExpand: rawText.length > 0,
    canOpenSurface: runtimeSurface !== undefined,
    trailingLabels: [{ text: t('toolActivity.canvas'), tone: 'muted' }],
    textBlocks: rawText ? [{ kind: 'output', text: rawText, copyable: false }] : [],
    canvasPreview: {
      title,
      runtimeSurface,
      surface: preview?.surface ?? item.preview.surface,
      sandbox: preview?.sandbox,
      boardWidgetName: preview?.boardWidgetName,
      preferredHeight: preview?.preferredHeight ?? item.preview.preferredHeight,
      rawText: rawText || undefined,
    },
  };
}
