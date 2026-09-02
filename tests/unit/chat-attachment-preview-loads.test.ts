import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionAssistantTurnItem } from '../../src/types/session/render-item';

const hostWorkspaceMediaThumbnailMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostWorkspaceMediaThumbnail: (...args: unknown[]) => hostWorkspaceMediaThumbnailMock(...args),
}));

describe('chat attachment preview loads', () => {
  beforeEach(() => {
    hostWorkspaceMediaThumbnailMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads outgoing Gateway media through the gateway URL preview payload', async () => {
    const { loadMissingItemPreviews } = await import('@/stores/chat/attachment-helpers');
    const gatewayUrl = '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full';
    const item: SessionAssistantTurnItem = {
      key: 'assistant-turn-1',
      kind: 'assistant-turn',
      sessionKey: 'agent:test:main',
      role: 'assistant',
      turnKey: 'main:turn:1',
      laneKey: 'main',
      identitySource: 'message',
      identityMode: 'message',
      identityConfidence: 'strong',
      status: 'final',
      segments: [{
        kind: 'media',
        key: 'media:main:0',
        images: [],
        attachedFiles: [{
          fileName: 'artifact.png',
          mimeType: 'image/png',
          fileSize: 0,
          preview: null,
          gatewayUrl,
          source: 'tool-result',
        }],
      }],
      thinking: null,
      tools: [],
      text: '',
      images: [],
      attachedFiles: [{
        fileName: 'artifact.png',
        mimeType: 'image/png',
        fileSize: 0,
        preview: null,
        gatewayUrl,
        source: 'tool-result',
      }],
    };

    const sessionIdentity = {
      endpoint: { kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
      agentId: 'main',
      sessionKey: 'agent:test:main',
    };
    hostWorkspaceMediaThumbnailMock.mockResolvedValueOnce({
      preview: 'data:image/png;base64,abc',
      fileSize: 123,
    });

    const result = await loadMissingItemPreviews([item], { sessionIdentity });

    expect(hostWorkspaceMediaThumbnailMock).toHaveBeenCalledWith({
      gatewayUrl,
      mimeType: 'image/png',
      agentId: 'main',
      sessionIdentity,
    });
    expect(result?.[0]).toMatchObject({
      kind: 'assistant-turn',
      attachedFiles: [{
        fileName: 'artifact.png',
        preview: 'data:image/png;base64,abc',
        fileSize: 123,
        gatewayUrl,
      }],
    });
  });

  it('loads an outgoing Gateway image when the record appears during retry', async () => {
    vi.useFakeTimers();
    const { loadMissingItemPreviews } = await import('@/stores/chat/attachment-helpers');
    const gatewayUrl = '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-retry/full';
    const item: SessionAssistantTurnItem = {
      key: 'assistant-turn-retry',
      kind: 'assistant-turn',
      sessionKey: 'agent:test:main',
      role: 'assistant',
      turnKey: 'main:turn:retry',
      laneKey: 'main',
      identitySource: 'message',
      identityMode: 'message',
      identityConfidence: 'strong',
      status: 'final',
      segments: [{
        kind: 'media',
        key: 'media:main:retry',
        images: [],
        attachedFiles: [{ fileName: 'artifact.png', mimeType: 'image/png', fileSize: 0, preview: null, gatewayUrl, source: 'tool-result' }],
      }],
      thinking: null,
      tools: [],
      text: '',
      images: [],
      attachedFiles: [{ fileName: 'artifact.png', mimeType: 'image/png', fileSize: 0, preview: null, gatewayUrl, source: 'tool-result' }],
    };
    const sessionIdentity = {
      endpoint: { kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
      agentId: 'main',
      sessionKey: 'agent:test:main',
    };
    hostWorkspaceMediaThumbnailMock
      .mockResolvedValueOnce({ preview: null, fileSize: 0 })
      .mockResolvedValueOnce({ preview: 'data:image/png;base64,abc', fileSize: 123 });

    const promise = loadMissingItemPreviews([item], { sessionIdentity });
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    expect(hostWorkspaceMediaThumbnailMock).toHaveBeenCalledTimes(2);
    expect(result?.[0]).toMatchObject({
      kind: 'assistant-turn',
      attachedFiles: [{ preview: 'data:image/png;base64,abc', fileSize: 123, gatewayUrl }],
    });
  });

  it('marks Gateway images unavailable only after bounded retries', async () => {
    vi.useFakeTimers();
    const { loadMissingItemPreviews } = await import('@/stores/chat/attachment-helpers');
    const gatewayUrl = '/api/chat/media/outgoing/agent%3Aother%3Amain/attachment-1/full';
    const item: SessionAssistantTurnItem = {
      key: 'assistant-turn-retry-unavailable',
      kind: 'assistant-turn',
      sessionKey: 'agent:test:main',
      role: 'assistant',
      turnKey: 'main:turn:retry-unavailable',
      laneKey: 'main',
      identitySource: 'message',
      identityMode: 'message',
      identityConfidence: 'strong',
      status: 'final',
      segments: [{
        kind: 'media',
        key: 'media:main:retry-unavailable',
        images: [],
        attachedFiles: [{ fileName: 'artifact.png', mimeType: 'image/png', fileSize: 0, preview: null, gatewayUrl, source: 'tool-result' }],
      }],
      thinking: null,
      tools: [],
      text: '',
      images: [],
      attachedFiles: [{ fileName: 'artifact.png', mimeType: 'image/png', fileSize: 0, preview: null, gatewayUrl, source: 'tool-result' }],
    };
    const sessionIdentity = {
      endpoint: { kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
      agentId: 'main',
      sessionKey: 'agent:test:main',
    };
    hostWorkspaceMediaThumbnailMock.mockResolvedValue({ preview: null, fileSize: 0 });

    const promise = loadMissingItemPreviews([item], { sessionIdentity });
    await vi.advanceTimersByTimeAsync(300 + 900 + 1800);
    const result = await promise;

    expect(hostWorkspaceMediaThumbnailMock).toHaveBeenCalledTimes(4);
    expect(result?.[0]).toMatchObject({
      kind: 'assistant-turn',
      attachedFiles: [{ preview: null, previewStatus: 'unavailable', gatewayUrl }],
    });
  });

  it('does not retry invalid Gateway references', async () => {
    const { loadMissingItemPreviews } = await import('@/stores/chat/attachment-helpers');
    const gatewayUrl = 'not-a-gateway-url';
    const item: SessionAssistantTurnItem = {
      key: 'assistant-turn-invalid',
      kind: 'assistant-turn',
      sessionKey: 'agent:test:main',
      role: 'assistant',
      turnKey: 'main:turn:invalid',
      laneKey: 'main',
      identitySource: 'message',
      identityMode: 'message',
      identityConfidence: 'strong',
      status: 'final',
      segments: [{
        kind: 'media',
        key: 'media:main:invalid',
        images: [],
        attachedFiles: [{ fileName: 'invalid.png', mimeType: 'image/png', fileSize: 0, preview: null, gatewayUrl, source: 'tool-result' }],
      }],
      thinking: null,
      tools: [],
      text: '',
      images: [],
      attachedFiles: [{ fileName: 'invalid.png', mimeType: 'image/png', fileSize: 0, preview: null, gatewayUrl, source: 'tool-result' }],
    };
    const sessionIdentity = {
      endpoint: { kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
      agentId: 'main',
      sessionKey: 'agent:test:main',
    };
    hostWorkspaceMediaThumbnailMock.mockResolvedValueOnce({ preview: null, fileSize: 0, error: 'invalidPath' });

    const result = await loadMissingItemPreviews([item], { sessionIdentity });

    expect(hostWorkspaceMediaThumbnailMock).toHaveBeenCalledTimes(1);
    expect(result?.[0]).toMatchObject({
      kind: 'assistant-turn',
      attachedFiles: [{ preview: null, previewStatus: 'unavailable', gatewayUrl }],
    });
  });
});
