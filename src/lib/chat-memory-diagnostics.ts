import { getAttachmentImageCacheStats } from '@/stores/chat/attachment-helpers';
import { useChatStore, type AttachedFileMeta, type ChatStoreState, type RawMessage } from '@/stores/chat';
import { isSessionHistoryReady } from '@/stores/chat/store-state-helpers';
import { getExecutionGraphCacheStats } from '@/pages/Chat/exec-graph-cache';
import { getMarkdownRenderCacheStats } from '@/pages/Chat/md-pipeline';
import { getStaticRowsCacheStats } from '@/pages/Chat/useRows';
import { getViewportListItemsCacheStats } from '@/pages/Chat/viewport-list-items';
import { hostApiFetch } from './host-api';
import { getChatViewportCacheStats } from '@/stores/chat/viewport-state';

interface RendererHeapMemoryStats {
  usedJsHeapSize: number;
  totalJsHeapSize: number;
  jsHeapSizeLimit: number;
}

interface ChatSessionMemorySummary {
  sessionKey: string;
  messageCount: number;
  attachedFileCount: number;
  previewCharCount: number;
  contentCharCount: number;
  runtimeStateCharCount: number;
  approxRetainedBytes: number;
  ready: boolean;
  lastActivityAt: number | null;
}

export interface ChatStoreMemorySummary {
  sessionCount: number;
  readySessionCount: number;
  totalMessageCount: number;
  totalAttachedFileCount: number;
  totalPreviewCharCount: number;
  totalDataUrlPreviewCharCount: number;
  totalContentCharCount: number;
  totalRuntimeStateCharCount: number;
  approxRetainedBytes: number;
  largestSessions: ChatSessionMemorySummary[];
}

export interface ChatRendererCacheSummary {
  markdownRender: ReturnType<typeof getMarkdownRenderCacheStats>;
  viewportWindow: ReturnType<typeof getChatViewportCacheStats>;
  staticRows: ReturnType<typeof getStaticRowsCacheStats>;
  viewportListItems: ReturnType<typeof getViewportListItemsCacheStats>;
  executionGraphs: ReturnType<typeof getExecutionGraphCacheStats>;
  attachmentImage: ReturnType<typeof getAttachmentImageCacheStats>;
}

interface ElectronProcessMemoryMetric {
  pid: number;
  type: string;
  creationTime: number;
  workingSetSizeKb: number | null;
  peakWorkingSetSizeKb: number | null;
  privateBytesKb: number | null;
  sharedBytesKb: number | null;
}

interface HostProcessMemoryDiagnostics {
  sampledAt: string;
  mainProcess: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  electronProcesses: {
    processCount: number;
    totalWorkingSetKb: number;
    byType: Array<{
      type: string;
      processCount: number;
      totalWorkingSetKb: number;
      totalPrivateBytesKb: number;
    }>;
    processes: ElectronProcessMemoryMetric[];
  };
}

export interface AppMemoryDiagnosticsSnapshot {
  sampledAt: string;
  rendererHeap: RendererHeapMemoryStats | null;
  chatStore: ChatStoreMemorySummary;
  caches: ChatRendererCacheSummary;
  host: HostProcessMemoryDiagnostics;
}

interface PerformanceMemoryLike {
  usedJSHeapSize?: unknown;
  totalJSHeapSize?: unknown;
  jsHeapSizeLimit?: unknown;
}

function estimateUnknownChars(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).length;
  }
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) {
      total += estimateUnknownChars(item);
    }
    return total;
  }
  if (!value || typeof value !== 'object') {
    return 0;
  }

  let total = 0;
  for (const [key, entry] of Object.entries(value)) {
    total += key.length;
    total += estimateUnknownChars(entry);
  }
  return total;
}

function estimateAttachedFiles(input: AttachedFileMeta[] | undefined): {
  fileCount: number;
  previewCharCount: number;
  dataUrlPreviewCharCount: number;
  approxChars: number;
} {
  const files = Array.isArray(input) ? input : [];
  let previewCharCount = 0;
  let dataUrlPreviewCharCount = 0;
  let approxChars = 0;

  for (const file of files) {
    const preview = typeof file.preview === 'string' ? file.preview : '';
    const fileName = typeof file.fileName === 'string' ? file.fileName : '';
    const mimeType = typeof file.mimeType === 'string' ? file.mimeType : '';
    const filePath = typeof file.filePath === 'string' ? file.filePath : '';
    previewCharCount += preview.length;
    if (preview.startsWith('data:')) {
      dataUrlPreviewCharCount += preview.length;
    }
    approxChars += preview.length + fileName.length + mimeType.length + filePath.length + 24;
  }

  return {
    fileCount: files.length,
    previewCharCount,
    dataUrlPreviewCharCount,
    approxChars,
  };
}

function estimateMessageChars(message: RawMessage): {
  contentChars: number;
  attachedFileCount: number;
  previewCharCount: number;
  dataUrlPreviewCharCount: number;
  approxChars: number;
} {
  const contentChars = estimateUnknownChars(message.content);
  const attachedFiles = estimateAttachedFiles(message._attachedFiles);
  const idChars = typeof message.id === 'string' ? message.id.length : 0;
  const toolCallChars = typeof message.toolCallId === 'string' ? message.toolCallId.length : 0;
  const toolNameChars = typeof message.toolName === 'string' ? message.toolName.length : 0;
  const approxChars = contentChars + attachedFiles.approxChars + idChars + toolCallChars + toolNameChars + 48;

  return {
    contentChars,
    attachedFileCount: attachedFiles.fileCount,
    previewCharCount: attachedFiles.previewCharCount,
    dataUrlPreviewCharCount: attachedFiles.dataUrlPreviewCharCount,
    approxChars,
  };
}

function estimateRuntimeStateChars(state: ChatStoreState, sessionKey: string): number {
  const runtime = state.loadedSessions[sessionKey]?.runtime;
  if (!runtime) {
    return 0;
  }

  let total = 0;
  const pendingUserMessage = runtime.pendingUserMessage?.message;
  if (pendingUserMessage) {
    total += estimateMessageChars(pendingUserMessage).approxChars;
  }

  if (runtime.streamingMessageId) {
    total += runtime.streamingMessageId.length;
  }

  total += runtime.streamingTools.length * 64;
  total += runtime.pendingToolImages.length * 64;
  return total;
}

export function summarizeChatStoreMemory(state: ChatStoreState): ChatStoreMemorySummary {
  const sessions = Object.entries(state.loadedSessions);
  const sessionSummaries: ChatSessionMemorySummary[] = [];
  let readySessionCount = 0;
  let totalMessageCount = 0;
  let totalAttachedFileCount = 0;
  let totalPreviewCharCount = 0;
  let totalDataUrlPreviewCharCount = 0;
  let totalContentCharCount = 0;
  let totalRuntimeStateCharCount = 0;
  let approxRetainedBytes = 0;

  for (const [sessionKey, record] of sessions) {
    const messages = Array.isArray(record.window?.messages) ? record.window.messages : [];
    let sessionContentChars = 0;
    let sessionAttachedFileCount = 0;
    let sessionPreviewCharCount = 0;
    let sessionDataUrlPreviewCharCount = 0;
    let sessionApproxChars = 0;

    for (const message of messages) {
      const stats = estimateMessageChars(message);
      sessionContentChars += stats.contentChars;
      sessionAttachedFileCount += stats.attachedFileCount;
      sessionPreviewCharCount += stats.previewCharCount;
      sessionDataUrlPreviewCharCount += stats.dataUrlPreviewCharCount;
      sessionApproxChars += stats.approxChars;
    }

    const runtimeStateCharCount = estimateRuntimeStateChars(state, sessionKey);
    const sessionApproxBytes = (sessionApproxChars + runtimeStateCharCount) * 2;
    sessionSummaries.push({
      sessionKey,
      messageCount: messages.length,
      attachedFileCount: sessionAttachedFileCount,
      previewCharCount: sessionPreviewCharCount,
      contentCharCount: sessionContentChars,
      runtimeStateCharCount,
      approxRetainedBytes: sessionApproxBytes,
      ready: isSessionHistoryReady(record.meta.historyStatus),
      lastActivityAt: record.meta.lastActivityAt ?? null,
    });

    if (isSessionHistoryReady(record.meta.historyStatus)) {
      readySessionCount += 1;
    }
    totalMessageCount += messages.length;
    totalAttachedFileCount += sessionAttachedFileCount;
    totalPreviewCharCount += sessionPreviewCharCount;
    totalDataUrlPreviewCharCount += sessionDataUrlPreviewCharCount;
    totalContentCharCount += sessionContentChars;
    totalRuntimeStateCharCount += runtimeStateCharCount;
    approxRetainedBytes += sessionApproxBytes;
  }

  sessionSummaries.sort((left, right) => right.approxRetainedBytes - left.approxRetainedBytes);

  return {
    sessionCount: sessions.length,
    readySessionCount,
    totalMessageCount,
    totalAttachedFileCount,
    totalPreviewCharCount,
    totalDataUrlPreviewCharCount,
    totalContentCharCount,
    totalRuntimeStateCharCount,
    approxRetainedBytes,
    largestSessions: sessionSummaries.slice(0, 5),
  };
}

export function readRendererHeapMemory(): RendererHeapMemoryStats | null {
  const performanceWithMemory = performance as Performance & { memory?: PerformanceMemoryLike };
  const heap = performanceWithMemory.memory;
  if (!heap) {
    return null;
  }

  const usedJsHeapSize = typeof heap.usedJSHeapSize === 'number' ? heap.usedJSHeapSize : null;
  const totalJsHeapSize = typeof heap.totalJSHeapSize === 'number' ? heap.totalJSHeapSize : null;
  const jsHeapSizeLimit = typeof heap.jsHeapSizeLimit === 'number' ? heap.jsHeapSizeLimit : null;
  if (usedJsHeapSize == null || totalJsHeapSize == null || jsHeapSizeLimit == null) {
    return null;
  }

  return {
    usedJsHeapSize,
    totalJsHeapSize,
    jsHeapSizeLimit,
  };
}

export function collectRendererChatMemoryDiagnostics(): {
  sampledAt: string;
  rendererHeap: RendererHeapMemoryStats | null;
  chatStore: ChatStoreMemorySummary;
  caches: ChatRendererCacheSummary;
} {
  const state = useChatStore.getState();
  return {
    sampledAt: new Date().toISOString(),
    rendererHeap: readRendererHeapMemory(),
    chatStore: summarizeChatStoreMemory(state),
    caches: {
      markdownRender: getMarkdownRenderCacheStats(),
      viewportWindow: getChatViewportCacheStats(),
      staticRows: getStaticRowsCacheStats(),
      viewportListItems: getViewportListItemsCacheStats(),
      executionGraphs: getExecutionGraphCacheStats(),
      attachmentImage: getAttachmentImageCacheStats(),
    },
  };
}

export async function collectAppMemoryDiagnostics(): Promise<AppMemoryDiagnosticsSnapshot> {
  const renderer = collectRendererChatMemoryDiagnostics();
  const host = await hostApiFetch<HostProcessMemoryDiagnostics>('/api/diagnostics/memory');
  return {
    sampledAt: renderer.sampledAt,
    rendererHeap: renderer.rendererHeap,
    chatStore: renderer.chatStore,
    caches: renderer.caches,
    host,
  };
}

export function installChatMemoryDiagnosticsDebugApi(target: Window): void {
  target.__MATCHACLAW_DEBUG__ = {
    ...(target.__MATCHACLAW_DEBUG__ ?? {}),
    collectMemoryDiagnostics: collectAppMemoryDiagnostics,
  };
}

