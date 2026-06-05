import { useEffect, useMemo, useState, memo, useReducer } from 'react';
import type { ChatAssistantTurnItem } from './chat-render-item-model';
import type { AttachedFileMeta } from '@/stores/chat';
import { AssistantMessageBody } from './assistant-message-body';
import { MessageShell } from './chat-message-shell';
import { ChatImageLightbox } from './components/ChatImageLightbox';
import { AssistantPendingIndicator } from './components/AssistantPendingIndicator';
import { getAssistantTurnPlainText } from './chat-message-view';
import {
  AssistantMessageMedia,
  AssistantEmbeddedToolResults,
  AssistantMessageMetaBar,
  ThinkingSection,
  ToolCardList,
  type MessageLightboxState,
} from './chat-message-parts';
import { extractArtifactRefsFromAssistantText } from './artifact-paths';
import { hostFileStat } from '@/lib/host-api';
import { DIRECTORY_MIME_TYPE } from '@/components/file-preview/types';
import type { RuntimeAddress } from '../../../runtime-host/shared/runtime-address';
import {
  containsTodoToolDebugSignal,
  logRendererTodoToolDebug,
  summarizeAssistantTurnForTodoToolDebug,
} from '@/stores/chat/todo-tool-debug';

interface ChatAssistantTurnProps {
  item: ChatAssistantTurnItem;
  showThinking: boolean;
  userAvatarImageUrl?: string | null;
  runtimeAddress?: RuntimeAddress;
  onOpenAttachedArtifact?: (file: AttachedFileMeta) => void;
}

type MarkdownFenceState = {
  marker: '`' | '~';
  length: number;
} | null;

type AssistantToolSegment = Extract<ChatAssistantTurnItem['segments'][number], { kind: 'tool' }>;
type AssistantBubbleCanvasToolSegment = AssistantToolSegment & {
  tool: AssistantToolSegment['tool'] & {
    result: Extract<AssistantToolSegment['tool']['result'], { kind: 'canvas' }>;
  };
};

function readFenceMarker(line: string): { marker: '`' | '~'; length: number; closingOnly: boolean } | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  const fence = match[1] ?? '';
  const rest = match[2] ?? '';
  const marker = fence[0] === '~' ? '~' : '`';
  return {
    marker,
    length: fence.length,
    closingOnly: rest.trim().length === 0,
  };
}

function advanceMarkdownFenceState(text: string, initialState: MarkdownFenceState): MarkdownFenceState {
  let state = initialState;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const fence = readFenceMarker(line);
    if (!fence) {
      continue;
    }
    if (state) {
      if (fence.marker === state.marker && fence.length >= state.length && fence.closingOnly) {
        state = null;
      }
      continue;
    }
    state = {
      marker: fence.marker,
      length: fence.length,
    };
  }
  return state;
}

function removeLeadingFenceClose(text: string, state: MarkdownFenceState): string {
  if (!state) {
    return text;
  }
  const match = /^(?: {0,3})(`{3,}|~{3,})[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return text;
  }
  const fence = match[1] ?? '';
  const marker = fence[0] === '~' ? '~' : '`';
  if (marker !== state.marker || fence.length < state.length) {
    return text;
  }
  return text.slice(match[0].length);
}

function buildMessageSegmentRenderTextByKey(item: ChatAssistantTurnItem): Map<string, string> {
  const renderTextByKey = new Map<string, string>();
  let fenceState: MarkdownFenceState = null;
  for (const segment of item.segments) {
    if (segment.kind !== 'message') {
      continue;
    }
    renderTextByKey.set(segment.key, removeLeadingFenceClose(segment.text, fenceState));
    fenceState = advanceMarkdownFenceState(segment.text, fenceState);
  }
  return renderTextByKey;
}

function isAssistantBubbleCanvasTool(segment: ChatAssistantTurnItem['segments'][number]): segment is AssistantBubbleCanvasToolSegment {
  return segment.kind === 'tool'
    && segment.tool.result.kind === 'canvas'
    && segment.tool.result.surface === 'assistant-bubble'
    && segment.tool.result.preview.surface === 'assistant_message';
}

export const ChatAssistantTurn = memo(function ChatAssistantTurn({
  item,
  showThinking,
  userAvatarImageUrl,
  runtimeAddress,
  onOpenAttachedArtifact,
}: ChatAssistantTurnProps) {
  const [collapseVersion, requestCollapse] = useReducer((value: number) => value + 1, 0);
  const [lightboxImg, setLightboxImg] = useState<MessageLightboxState | null>(null);
  const [validatedDerivedPaths, setValidatedDerivedPaths] = useState<Record<string, boolean>>({});

  const isStreaming = item.status === 'streaming' || item.status === 'waiting_tool';

  useEffect(() => {
    if (!containsTodoToolDebugSignal(item)) {
      return;
    }
    logRendererTodoToolDebug(
      'renderer.ChatAssistantTurn.render-item',
      summarizeAssistantTurnForTodoToolDebug(item),
    );
  }, [item]);

  const messageRenderTextByKey = useMemo(() => buildMessageSegmentRenderTextByKey(item), [item]);

  const hasContentSegments = item.segments.some((segment) => {
    if (segment.kind === 'thinking') {
      return showThinking && segment.text.trim().length > 0;
    }
    if (segment.kind === 'message') {
      return segment.text.trim().length > 0;
    }
    if (segment.kind === 'tool') {
      return true;
    }
    return segment.images.length > 0 || segment.attachedFiles.length > 0;
  });
  const pendingMode = hasContentSegments ? null : item.pendingState ?? null;
  const plainText = getAssistantTurnPlainText(item);
  const attachedByPath = useMemo(() => {
    const next = new Set<string>();
    for (const segment of item.segments) {
      if (segment.kind !== 'media') {
        continue;
      }
      for (const file of segment.attachedFiles as AttachedFileMeta[]) {
        if (file.filePath) {
          next.add(file.filePath);
        }
      }
    }
    return next;
  }, [item.segments]);
  const derivedAttachedFiles = useMemo(() => (
    extractArtifactRefsFromAssistantText(plainText).filter((file) => !file.filePath || !attachedByPath.has(file.filePath))
  ), [attachedByPath, plainText]);

  useEffect(() => {
    if (!runtimeAddress) {
      return;
    }
    if (derivedAttachedFiles.length === 0) {
      return;
    }
    const pendingPaths = derivedAttachedFiles
      .map((file) => file.filePath)
      .filter((filePath): filePath is string => !!filePath && validatedDerivedPaths[filePath] === undefined);
    if (pendingPaths.length === 0) {
      return;
    }

    let cancelled = false;
    void Promise.all(pendingPaths.map(async (filePath) => {
      try {
        const stat = await hostFileStat({ path: filePath, runtimeAddress });
        const expectDir = derivedAttachedFiles.find((file) => file.filePath === filePath)?.mimeType === DIRECTORY_MIME_TYPE;
        return {
          filePath,
          ok: !!stat.ok && !!stat.entry && (expectDir ? stat.entry.isDir : !stat.entry.isDir),
        };
      } catch {
        return { filePath, ok: false };
      }
    })).then((results) => {
      if (cancelled) {
        return;
      }
      setValidatedDerivedPaths((current) => {
        const next = { ...current };
        for (const result of results) {
          next[result.filePath] = result.ok;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [derivedAttachedFiles, runtimeAddress, validatedDerivedPaths]);

  const visibleDerivedAttachedFiles = useMemo(() => (
    derivedAttachedFiles.filter((file) => !file.filePath || validatedDerivedPaths[file.filePath] === true)
  ), [derivedAttachedFiles, validatedDerivedPaths]);
  if (!hasContentSegments && !pendingMode) {
    return null;
  }

  return (
    <>
      <MessageShell
        isUser={false}
        assistantAgentId={item.assistantPresentation?.agentId}
        assistantAgentName={item.assistantPresentation?.agentName}
        assistantAvatarSeed={item.assistantPresentation?.avatarSeed}
        assistantAvatarStyle={item.assistantPresentation?.avatarStyle}
        userAvatarImageUrl={userAvatarImageUrl}
      >
        {item.segments.map((segment) => {
          if (segment.kind === 'thinking') {
            if (!showThinking || !segment.text.trim()) {
              return null;
            }
            return (
              <div key={segment.key} className="flex flex-col items-start gap-0.5 pt-0.5">
                <ThinkingSection content={segment.text} collapseVersion={collapseVersion} />
              </div>
            );
          }
          if (segment.kind === 'tool') {
            if (isAssistantBubbleCanvasTool(segment)) {
              const embeddedToolResults = [{
                key: segment.tool.toolCallId || segment.tool.id || segment.key,
                ...(segment.tool.toolCallId ? { toolCallId: segment.tool.toolCallId } : {}),
                toolName: segment.tool.name,
                preview: segment.tool.result.preview,
                ...(segment.tool.result.rawText ? { rawText: segment.tool.result.rawText } : {}),
              }];
              return (
                <div key={segment.key} className="flex flex-col items-start gap-0 pt-0">
                  <AssistantEmbeddedToolResults
                    embeddedToolResults={embeddedToolResults}
                    collapseVersion={collapseVersion}
                  />
                </div>
              );
            }
            return (
              <div key={segment.key} className="flex flex-col items-start gap-0 pt-0">
                <ToolCardList tools={[segment.tool]} collapseVersion={collapseVersion} />
              </div>
            );
          }
          if (segment.kind === 'message') {
          return (
            <AssistantMessageBody
              key={segment.key}
              itemKey={`${item.key}:segment:${segment.key}`}
              createdAt={item.createdAt}
              text={messageRenderTextByKey.get(segment.key) ?? segment.text}
              isStreaming={isStreaming}
              onBodyClick={requestCollapse}
            />
          );
          }
          return (
            <AssistantMessageMedia
              key={segment.key}
              images={segment.images}
              attachedFiles={segment.attachedFiles}
              onPreview={setLightboxImg}
              onOpenFile={onOpenAttachedArtifact}
            />
          );
        })}

        {visibleDerivedAttachedFiles.length > 0 ? (
          <AssistantMessageMedia
            images={[]}
            attachedFiles={visibleDerivedAttachedFiles}
            onPreview={setLightboxImg}
            onOpenFile={onOpenAttachedArtifact}
          />
        ) : null}

        {pendingMode ? <AssistantPendingIndicator mode={pendingMode} /> : null}

        {plainText && <AssistantMessageMetaBar text={plainText} timestamp={item.createdAt} />}
      </MessageShell>

      {lightboxImg && (
        <ChatImageLightbox
          src={lightboxImg.src}
          fileName={lightboxImg.fileName}
          filePath={lightboxImg.filePath}
          onClose={() => setLightboxImg(null)}
        />
      )}
    </>
  );
});
