import type {
  SessionRenderAttachedFile,
  SessionRenderImage,
} from '../../types/session/tool-card';

const OPENCLAW_GATEWAY_MEDIA_MARKER = '/api/chat/media/outgoing/';

export interface ProjectedSessionMedia {
  images: SessionRenderImage[];
  attachedFiles: SessionRenderAttachedFile[];
}

interface SessionMediaContent {
  kind: string;
  mediaType?: string | null;
  reference?: string;
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
    const attachmentStatus = reason === 'thinking'
      ? 'thinking-omitted'
      : reason === 'unsafe_media' || reason === 'unsafeMedia' ? 'unsafe-media-omitted' : 'unknown-omitted';
    return {
      images: [],
      attachedFiles: [{
        fileName: 'Attachment omitted',
        mimeType: 'application/octet-stream',
        fileSize: 0,
        preview: null,
        attachmentStatus,
      }],
    };
  }
  if (content.kind !== 'media') {
    return { images: [], attachedFiles: [] };
  }
  const reference = safeMediaReference(content.reference);
  if (!reference) {
    return {
      images: [],
      attachedFiles: [{
        fileName: 'Attachment',
        mimeType: content.mediaType || 'application/octet-stream',
        fileSize: 0,
        preview: null,
        attachmentStatus: 'unsafe-media-omitted',
      }],
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
      fileName: fileNameFromMediaReference(reference),
      mimeType,
      fileSize: 0,
      preview: null,
      gatewayUrl: reference,
      source: 'message-ref',
    }],
  };
}
