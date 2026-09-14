export type SessionRenderAttachmentStatus =
  | 'preview-unavailable'
  | 'unsafe-media-omitted'
  | 'unknown-omitted'
  | 'thinking-omitted';

export interface SessionRenderAttachedFile {
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  previewStatus?: 'unavailable';
  attachmentStatus?: SessionRenderAttachmentStatus;
  filePath?: string;
  gatewayUrl?: string;
  source?: 'user-upload' | 'tool-result' | 'message-ref';
}

export interface SessionRenderImage {
  url?: string;
  data?: string;
  mimeType: string;
}

export type SessionRenderToolRuntimeAdapterId = 'openclaw' | 'matcha-agent';

export type SessionRenderToolStatusKind = 'running' | 'completed' | 'error' | 'missing_result';

export interface SessionRenderToolPreviewCanvas {
  kind: 'canvas';
  surface: 'assistant_message';
  render: 'url';
  title?: string;
  preferredHeight?: number;
  url: string;
  viewId: string;
}

export type SessionRenderToolPreview = SessionRenderToolPreviewCanvas;

export interface SessionRenderToolResultNone {
  kind: 'none';
  surface: 'tool-card';
}

export interface SessionRenderToolResultText {
  kind: 'text';
  surface: 'tool-card';
  collapsedPreview: string;
  bodyText: string;
}

export interface SessionRenderToolResultJson {
  kind: 'json';
  surface: 'tool-card';
  collapsedPreview: string;
  bodyText: string;
}

export interface SessionRenderToolResultCanvas {
  kind: 'canvas';
  surface: 'assistant-bubble';
  collapsedPreview: string;
  preview: SessionRenderToolPreview;
  rawText?: string;
}

export type SessionRenderToolResult =
  | SessionRenderToolResultNone
  | SessionRenderToolResultText
  | SessionRenderToolResultJson
  | SessionRenderToolResultCanvas;

export interface SessionRenderAssistantBubbleToolResult {
  key: string;
  toolCallId?: string;
  toolName: string;
  preview: SessionRenderToolPreview;
  rawText?: string;
}

export interface SessionRenderToolCard {
  id: string;
  toolCallId?: string;
  parentMessageId?: string;
  name: string;
  displayTitle: string;
  displayDetail?: string;
  input: unknown;
  inputText?: string;
  status: SessionRenderToolStatusKind;
  summary?: string;
  durationMs?: number;
  updatedAt?: number;
  firstSeenOrder?: number;
  runtimeAdapterId?: SessionRenderToolRuntimeAdapterId;
  output?: unknown;
  details?: unknown;
  result: SessionRenderToolResult;
}

/** Renderer-safe canonical content block. Provider payloads are never carried here. */
export type SessionTimelineContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'largeText'; text: string; contentRef: string; totalBytes: number; loadedBytes: number }
  | { kind: 'toolUse'; name: string; toolCallId?: string }
  | { kind: 'toolResult'; toolName?: string; toolCallId?: string; summary?: string; isError?: boolean }
  | { kind: 'media'; mediaType?: string; reference?: string }
  | { kind: 'omitted'; omittedKind: 'thinking' | 'unsafeMedia' | 'unknown' };

export interface SessionAssistantThinkingSegment {
  kind: 'thinking';
  key: string;
  text: string;
  parentMessageId?: string;
  firstSeenOrder?: number;
}

export interface SessionAssistantToolSegment {
  kind: 'tool';
  key: string;
  tool: SessionRenderToolCard;
  parentMessageId?: string;
  firstSeenOrder?: number;
}

export interface SessionLargeTextMetadata {
  contentRef: string;
  totalBytes: number;
  loadedBytes: number;
}

export interface SessionAssistantMessageSegment {
  kind: 'message';
  key: string;
  messageId?: string;
  text: string;
  largeText?: SessionLargeTextMetadata;
  parentMessageId?: string;
  firstSeenOrder?: number;
}

export interface SessionAssistantMediaSegment {
  kind: 'media';
  key: string;
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  parentMessageId?: string;
  firstSeenOrder?: number;
}

export type SessionAssistantTurnSegment =
  | SessionAssistantThinkingSegment
  | SessionAssistantToolSegment
  | SessionAssistantMessageSegment
  | SessionAssistantMediaSegment;
