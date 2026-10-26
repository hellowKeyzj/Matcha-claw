import type { MessagePartProps } from './extensions';
import { AssistantMessageBody } from './assistant-message-body';
import { AssistantEmbeddedToolResults, AssistantMessageMedia, ThinkingSection, ToolCardList } from './chat-message-parts';
import type { SessionRenderAssistantBubbleToolResult } from '@/types/session/tool-card';

export function ThinkingPart({ segment, showThinking, collapseVersion }: MessagePartProps) {
  if (segment.kind !== 'thinking' || !showThinking || !segment.text.trim()) return null;
  return (
    <div className="flex w-full flex-col items-start gap-0.5 pt-0.5">
      <ThinkingSection content={segment.text} collapseVersion={collapseVersion} />
    </div>
  );
}

export function ToolPart({ segment, toolSlot, collapseVersion, toolSessionIdentity, disclosure, latestBrowserTools, onOpenToolSurface, onRuntimeSendMessage, onRuntimeOpenLink }: MessagePartProps) {
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

export function TextPart({ segment, itemKey, createdAt, renderText, isStreaming, sessionIdentity, endpointSessionId, onBodyClick }: MessagePartProps) {
  if (segment.kind !== 'message') return null;
  const text = renderText ?? segment.text;
  if (!segment.largeText && !text.trim()) return null;
  return (
    <AssistantMessageBody
      itemKey={`${itemKey}:segment:${segment.key}`}
      createdAt={createdAt}
      text={text}
      isStreaming={isStreaming}
      largeText={segment.largeText}
      sessionIdentity={sessionIdentity}
      endpointSessionId={endpointSessionId}
      onBodyClick={onBodyClick}
    />
  );
}

export function MediaPart({ segment, onPreview, onOpenFile }: MessagePartProps) {
  if (segment.kind !== 'media') return null;
  return <AssistantMessageMedia images={segment.images} attachedFiles={segment.attachedFiles} onPreview={onPreview} onOpenFile={onOpenFile} />;
}
