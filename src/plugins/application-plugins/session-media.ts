import i18n from '@/i18n';
import { hostFileReadBinary, hostListSessionImages, hostReadSessionImage, WorkspaceSessionImagesError, type WorkspaceSessionImage, type WorkspaceSessionImagesErrorCode } from '@/lib/host-api';
import { readSessionMedia, subscribeSessionMedia, type SessionMediaEntry } from '@/plugins/chat/session-media';
import type { AppSessionMediaData, AppSessionMediaList, AppSessionMediaListRequest } from '@/types/desktop/app-plugin-sdk';
import { buildSessionIdentityKey, type SessionIdentity } from '@/types/desktop/runtime-address';

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

type MediaEntry = { kind: 'loaded'; media: SessionMediaEntry } | { kind: 'history'; media: WorkspaceSessionImage };

function mediaError(code: WorkspaceSessionImagesErrorCode, key: 'mediaChanged' | 'mediaReadFailed' | 'invalidMedia' = 'mediaReadFailed') {
  return Object.assign(new Error(i18n.t(`common:appFrame.${key}`)), { code });
}

function validateMediaData(data: unknown, expectedSize?: number): asserts data is string {
  if (typeof data === 'string' && data.length > 4 * Math.ceil(MAX_MEDIA_BYTES / 3)) throw mediaError('tooLarge', 'invalidMedia');
  if (typeof data !== 'string' || !data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw mediaError('unavailable', 'invalidMedia');
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const size = data.length / 4 * 3 - padding;
  if (size > MAX_MEDIA_BYTES) throw mediaError('tooLarge', 'invalidMedia');
  const terminal = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    .indexOf(data.charAt(data.length - padding - 1));
  if (size <= 0 || (expectedSize !== undefined && size !== expectedSize)
    || terminal < 0 || terminal % (padding === 0 ? 1 : padding === 1 ? 4 : 16) !== 0) {
    throw mediaError('unavailable', 'invalidMedia');
  }
}

export function createAppSessionMedia(identity: SessionIdentity) {
  const sourceIdentity = { ...identity, endpoint: { ...identity.endpoint } };
  const identityKey = buildSessionIdentityKey(sourceIdentity);
  const directory = new Map<string, MediaEntry>();
  let revision = 0;
  let round = 0;
  let nextCursor: { opaque: string; native: string; revision: number; round: number } | undefined;
  const currentEntry = (entry: SessionMediaEntry) => readSessionMedia(sourceIdentity).items.find((candidate) => candidate.key === entry.key
    && candidate.name === entry.name && candidate.mimeType === entry.mimeType && candidate.source.relativePath === entry.source.relativePath);
  const invalidate = () => {
    round += 1;
    directory.clear();
    nextCursor = undefined;
  };
  const mediaId = async (entry: MediaEntry) => {
    const key = entry.kind === 'loaded' ? entry.media.key : entry.media.reference;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([identityKey, entry.kind, key])));
    return `media_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  };

  return {
    async list(signal: AbortSignal, request?: AppSessionMediaListRequest): Promise<AppSessionMediaList> {
      signal.throwIfAborted();
      const firstPage = request?.cursor === undefined;
      const continuation = nextCursor;
      if (firstPage) invalidate();
      else if (!continuation || request.cursor !== continuation.opaque
        || continuation.revision !== revision || continuation.round !== round) {
        invalidate();
        throw mediaError('cursorInvalid', 'mediaChanged');
      }
      nextCursor = undefined;
      const sourceRevision = revision;
      const sourceRound = round;
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (sourceRevision !== revision || sourceRound !== round) throw mediaError('cursorInvalid', 'mediaChanged');
      };
      const entries: MediaEntry[] = firstPage
        ? readSessionMedia(sourceIdentity).items.map((media) => ({ kind: 'loaded', media })) : [];
      let page: Awaited<ReturnType<typeof hostListSessionImages>> | undefined;
      try {
        if (sourceIdentity.endpoint.kind !== 'native-runtime') throw new WorkspaceSessionImagesError('unsupported');
        page = await hostListSessionImages(sourceIdentity, firstPage ? undefined : continuation!.native);
      } catch (error) {
        assertCurrent();
        const code = error instanceof WorkspaceSessionImagesError ? error.code : 'unavailable';
        if (!firstPage || code !== 'unsupported') {
          invalidate();
          throw mediaError(code, code === 'cursorInvalid' ? 'mediaChanged' : 'mediaReadFailed');
        }
      }
      assertCurrent();
      for (const media of page?.items ?? []) entries.push({ kind: 'history', media });
      const additions = new Map<string, MediaEntry>();
      for (const entry of entries) {
        additions.set(await mediaId(entry), entry);
        assertCurrent();
      }
      for (const [id, entry] of additions) directory.set(id, entry);
      if (page?.nextCursor !== undefined) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const opaque = `media_cursor_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
        nextCursor = { opaque, native: page.nextCursor, revision: sourceRevision, round: sourceRound };
      }
      return {
        scope: page ? 'session-images' : 'loaded-window',
        historyImages: page ? 'supported' : 'unsupported',
        omittedOversized: page?.omittedOversized ?? false,
        items: Array.from(additions, ([id, entry]) => ({
          id, name: entry.media.name,
          ...(entry.media.mimeType === undefined ? {} : { mimeType: entry.media.mimeType }),
          readable: entry.kind === 'loaded' || entry.media.readable,
        })),
        ...(nextCursor ? { nextCursor: nextCursor.opaque } : {}),
      };
    },
    async read(id: string, signal: AbortSignal): Promise<AppSessionMediaData> {
      signal.throwIfAborted();
      const entry = directory.get(id);
      if (!entry) throw mediaError('invalidReference', 'mediaChanged');
      const sourceRevision = revision;
      const sourceRound = round;
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (sourceRevision !== revision || sourceRound !== round || directory.get(id) !== entry
          || (entry.kind === 'loaded' && !currentEntry(entry.media))) throw mediaError('invalidReference', 'mediaChanged');
      };
      assertCurrent();
      if (entry.kind === 'history') {
        if (!entry.media.readable) throw mediaError('invalidReference');
        let result: AppSessionMediaData;
        try { result = await hostReadSessionImage(sourceIdentity, entry.media.reference); }
        catch (error) {
          assertCurrent();
          const code = error instanceof WorkspaceSessionImagesError ? error.code : 'unavailable';
          if (code === 'cursorInvalid' || code === 'invalidReference') invalidate();
          throw mediaError(code, code === 'cursorInvalid' || code === 'invalidReference' ? 'mediaChanged' : 'mediaReadFailed');
        }
        assertCurrent();
        validateMediaData(result.data);
        return result;
      }
      const result = await hostFileReadBinary({
        endpoint: sourceIdentity.endpoint,
        agentId: sourceIdentity.agentId,
        relativePath: entry.media.source.relativePath,
        maxBytes: MAX_MEDIA_BYTES,
      });
      assertCurrent();
      if (!result.ok) throw mediaError(result.error === 'tooLarge' ? 'tooLarge' : 'unavailable');
      if (!Number.isSafeInteger(result.size) || !result.size) throw mediaError('unavailable', 'invalidMedia');
      validateMediaData(result.data, result.size);
      return { data: result.data, name: entry.media.name, mimeType: entry.media.mimeType };
    },
    subscribe(listener: () => void): () => void {
      return subscribeSessionMedia(sourceIdentity, () => {
        revision += 1;
        invalidate();
        listener();
      });
    },
  };
}
