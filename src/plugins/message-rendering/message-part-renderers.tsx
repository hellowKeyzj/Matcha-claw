import { useEffect, useId, useRef } from 'react';
import type { MessagePartProps } from './extensions';
import { ContentNotices } from './content-notices';
import { AssistantMessageBody } from './assistant-message-body';
import { AssistantEmbeddedToolResults, AssistantMessageMedia, ThinkingSection, ToolCardList } from './chat-message-parts';
import type { SessionRenderAssistantBubbleToolResult } from '@/types/session/tool-card';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeSessionIdentity, summarizeText } from '@/lib/session-trace';

export function ThinkingPart({ segment, itemKey, sessionIdentity, isStreaming, showThinking, collapseVersion }: MessagePartProps) {
  const instanceId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const committedTraceRef = useRef<(() => Record<string, unknown>) | null>(null);

  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    const container = containerRef.current;
    const payload = {
      identity: summarizeSessionIdentity(sessionIdentity), instanceHash: summarizeIdentifier(instanceId).hash,
      itemHash: summarizeIdentifier(itemKey).hash, segmentHash: summarizeIdentifier(segment.key).hash,
      content: segment.kind === 'thinking' ? summarizeText(segment.text) : null,
      rendered: container !== null, showThinking, isStreaming,
    };
    committedTraceRef.current = () => ({
      ...payload, containerConnected: container?.isConnected ?? false,
    });
    logSessionTrace('session.thinking-part.committed', 'session-thinking-part-boundary', committedTraceRef.current);
  });

  useEffect(() => {
    if (!isSessionTraceEnabled() || !committedTraceRef.current) return;
    // StrictMode replays effects with the same instanceHash; effect stages do not count DOM instances.
    logSessionTrace('session.thinking-part.effect-mounted', 'session-thinking-part-boundary', committedTraceRef.current);
    return () => {
      if (!isSessionTraceEnabled() || !committedTraceRef.current) return;
      logSessionTrace('session.thinking-part.effect-cleanup', 'session-thinking-part-boundary', committedTraceRef.current);
    };
  }, []);

  if (segment.kind !== 'thinking' || !showThinking || !segment.text.trim()) return null;
  return (
    <div ref={containerRef} className="flex w-full flex-col items-start gap-0.5 pt-0.5">
      <ThinkingSection content={segment.text} collapseVersion={collapseVersion} />
    </div>
  );
}

export function ToolPart({ segment, toolSlot, collapseVersion, toolSessionIdentity, toolIsImmutable, disclosure, latestBrowserTools, onOpenToolSurface, onRuntimeSendMessage, onRuntimeOpenLink }: MessagePartProps) {
  if (segment.kind !== 'tool') return null;
  const tool = segment.tool;
  const result = tool.result;
  const embedded: SessionRenderAssistantBubbleToolResult | null = result.kind === 'canvas'
    && result.surface === 'assistant-bubble' && result.preview.surface === 'assistant_message'
    ? {
      key: tool.toolCallId || tool.id || segment.key,
      ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
      toolName: tool.name,
      preview: result.preview,
      ...(result.rawText ? { rawText: result.rawText } : {}),
    } : null;
  if (!embedded && toolSlot?.kind !== 'head') return null;
  return (
    <div className="flex w-full flex-col items-start gap-0 pt-0">
      {embedded ? (
        <AssistantEmbeddedToolResults
          embeddedToolResults={[embedded]}
          sourceTool={tool}
          sourceToolIsImmutable={toolIsImmutable}
          collapseVersion={collapseVersion}
          sessionIdentity={toolSessionIdentity}
          onOpenToolSurface={onOpenToolSurface}
          onRuntimeSendMessage={toolSessionIdentity ? onRuntimeSendMessage : undefined}
          onRuntimeOpenLink={toolSessionIdentity ? onRuntimeOpenLink : undefined}
        />
      ) : toolSlot?.kind === 'head' ? (
        <ToolCardList
          tools={toolSlot.group.tools}
          latestBrowserTools={latestBrowserTools}
          collapseVersion={collapseVersion}
          sessionIdentity={toolSessionIdentity}
          groupKey={toolSlot.group.key}
          disclosure={disclosure}
          onOpenToolSurface={onOpenToolSurface}
          onRuntimeSendMessage={toolSessionIdentity ? onRuntimeSendMessage : undefined}
          onRuntimeOpenLink={toolSessionIdentity ? onRuntimeOpenLink : undefined}
        />
      ) : null}
    </div>
  );
}

export function TextPart({ segment, itemKey, createdAt, renderText, attachedFiles, isStreaming, sessionIdentity, endpointSessionId, onBodyClick, onOpenFile }: MessagePartProps) {
  if (segment.kind !== 'message') return null;
  const text = renderText ?? segment.text;
  if (!segment.largeText && !text.trim()) return null;
  return (
    <AssistantMessageBody
      itemKey={`${itemKey}:segment:${segment.key}`}
      createdAt={createdAt}
      text={text}
      attachedFiles={attachedFiles}
      isStreaming={isStreaming}
      largeText={segment.largeText}
      sessionIdentity={sessionIdentity}
      endpointSessionId={endpointSessionId}
      onBodyClick={onBodyClick}
      onOpenFile={onOpenFile}
    />
  );
}

export function MediaPart({ segment, onPreview, onOpenFile, sessionIdentity }: MessagePartProps) {
  if (segment.kind !== 'media') return null;
  return (
    <>
      <AssistantMessageMedia images={segment.images} attachedFiles={segment.attachedFiles} sessionIdentity={sessionIdentity} onPreview={onPreview} onOpenFile={onOpenFile} />
      <ContentNotices notices={segment.contentNotices} />
    </>
  );
}
