import type {
  SessionRenderAttachedFile,
  SessionRenderContentNotice,
  SessionRenderImage,
} from '@/types/session/tool-card';
import { builtinFileFormats } from '@/plugins/files/file-types';

const OPENCLAW_GATEWAY_MEDIA_MARKER = '/api/chat/media/outgoing/';
const MEDIA_MIME_EXTENSIONS = builtinFileFormats.flatMap((format) => Object.entries(format.mimeTypes ?? {}));

export interface ProjectedSessionMedia {
  images: SessionRenderImage[];
  attachedFiles: SessionRenderAttachedFile[];
  contentNotices?: SessionRenderContentNotice[];
}

interface SessionMediaContent {
  kind: string;
  mediaType?: string | null;
  reference?: string;
  fileName?: string;
  sizeBytes?: number;
  resourceId?: string;
  reason?: string;
  omittedKind?: string;
}

function safeMediaReference(reference: string | undefined): string | undefined {
  if (typeof reference !== 'string') {
    return undefined;
  }
  const value = reference.trim();
  if (!value || value.startsWith('data:') || value.startsWith('file:')) {
    return undefined;
  }
  return value.startsWith('http://')
    || value.startsWith('https://')
    || value.startsWith('/api/')
    ? value
    : undefined;
}

export function isOpenClawGatewayMediaReference(reference: string): boolean {
  return reference.includes(OPENCLAW_GATEWAY_MEDIA_MARKER);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function fileNameFromMediaReference(reference: string): string {
  const cleanReference = reference.split(/[?#]/, 1)[0] || reference;
  const markerIndex = cleanReference.indexOf(OPENCLAW_GATEWAY_MEDIA_MARKER);
  if (markerIndex >= 0) {
    const tail = cleanReference.slice(markerIndex + OPENCLAW_GATEWAY_MEDIA_MARKER.length);
    const parts = tail.split('/').filter(Boolean).map(safeDecodeURIComponent);
    return parts[1] || parts[0] || 'media';
  }
  const leaf = cleanReference.split('/').filter(Boolean).pop();
  return leaf ? safeDecodeURIComponent(leaf) : 'media';
}

export function projectSessionMedia(content: SessionMediaContent): ProjectedSessionMedia {
  if (content.kind === 'omitted') {
    const reason = content.reason ?? content.omittedKind;
    return {
      images: [],
      attachedFiles: [],
      ...(reason === 'thinking' ? {} : {
        contentNotices: [reason === 'unsafe_media' || reason === 'unsafeMedia' ? 'media-unavailable' : 'content-omitted'],
      }),
    };
  }
  if (content.kind !== 'media') {
    return { images: [], attachedFiles: [] };
  }
  if (typeof content.reference === 'string'
    && content.reference.length <= 512
    && /^(?:oc|ma)-media:1:[A-Za-z0-9_-]+$/.test(content.reference)) {
    const mimeType = content.mediaType || 'application/octet-stream';
    return {
      images: [],
      attachedFiles: [{
        fileName: content.fileName ?? `media${MEDIA_MIME_EXTENSIONS.find(([, mime]) => mime === mimeType.toLowerCase())?.[0] ?? ''}`,
        mimeType,
        fileSize: content.sizeBytes ?? 0,
        preview: null,
        mediaReference: content.reference,
        ...(content.resourceId ? { resourceId: content.resourceId } : {}),
        source: 'message-ref',
      }],
    };
  }
  const reference = safeMediaReference(content.reference);
  if (!reference) {
    return {
      images: [],
      attachedFiles: [],
      contentNotices: ['media-unavailable'],
    };
  }
  const mimeType = content.mediaType || 'application/octet-stream';
  const isImage = mimeType.toLowerCase().startsWith('image/');
  if (isImage && !isOpenClawGatewayMediaReference(reference)) {
    return { images: [{ url: reference, mimeType }], attachedFiles: [] };
  }
  return {
    images: [],
    attachedFiles: [{
      fileName: content.fileName ?? fileNameFromMediaReference(reference),
      mimeType,
      fileSize: content.sizeBytes ?? 0,
      preview: null,
      gatewayUrl: reference,
      ...(content.resourceId ? { resourceId: content.resourceId } : {}),
      source: 'message-ref',
    }],
  };
}
