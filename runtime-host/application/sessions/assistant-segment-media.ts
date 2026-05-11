import type {
  SessionRenderAttachedFile,
  SessionRenderImage,
} from '../../shared/session-adapter-types';

export interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
  data?: unknown;
  mimeType?: unknown;
  url?: unknown;
  alt?: unknown;
  id?: unknown;
  toolCallId?: unknown;
  name?: unknown;
  content?: unknown;
}

export function extractImagesFromSingleBlock(block: ContentBlockLike): SessionRenderImage[] {
  if (block.type !== 'image') {
    return [];
  }
  if (block.source?.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
    return [{
      mimeType: block.source.media_type,
      data: block.source.data,
    }];
  }
  if (block.source?.type === 'url' && typeof block.source.url === 'string') {
    return [{
      mimeType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/jpeg',
      url: block.source.url,
    }];
  }
  if (typeof block.data === 'string') {
    return [{
      mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg',
      data: block.data,
    }];
  }
  return [];
}

export function extractImagesAsAttachedFiles(content: unknown): SessionRenderAttachedFile[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const files: SessionRenderAttachedFile[] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type === 'image') {
      if (block.source?.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
        files.push({
          fileName: 'image',
          mimeType: block.source.media_type,
          fileSize: 0,
          preview: `data:${block.source.media_type};base64,${block.source.data}`,
          source: 'message-ref',
        });
      } else if (block.source?.type === 'url' && typeof block.source.url === 'string') {
        files.push({
          fileName: 'image',
          mimeType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/jpeg',
          fileSize: 0,
          preview: block.source.url,
          source: 'message-ref',
        });
      } else if (typeof block.data === 'string') {
        const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg';
        files.push({
          fileName: 'image',
          mimeType,
          fileSize: 0,
          preview: `data:${mimeType};base64,${block.data}`,
          source: 'message-ref',
        });
      } else if (typeof block.url === 'string' && block.url.trim()) {
        files.push({
          fileName: typeof block.alt === 'string' && block.alt.trim() ? block.alt.trim() : 'image',
          mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg',
          fileSize: 0,
          preview: null,
          gatewayUrl: block.url.trim(),
          source: 'tool-result',
        });
      }
    }
    if ((block.type === 'tool_result' || block.type === 'toolResult') && block.content !== undefined) {
      files.push(...extractImagesAsAttachedFiles(block.content).map((file): SessionRenderAttachedFile => ({
        ...file,
        source: 'tool-result',
      })));
    }
  }
  return files;
}
