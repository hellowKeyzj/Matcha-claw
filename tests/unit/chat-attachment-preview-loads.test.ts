import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionAssistantTurnItem } from '../../runtime-host/shared/session-adapter-types';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('chat attachment preview loads', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
    localStorage.clear();
  });

  it('loads missing previews for gateway media attachments through host thumbnails', async () => {
    const { loadMissingItemPreviews } = await import('@/stores/chat/attachment-helpers');
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
          gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
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
        gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
        source: 'tool-result',
      }],
    };

    hostApiFetchMock.mockResolvedValueOnce({
      '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full': {
        preview: 'data:image/png;base64,abc',
        fileSize: 123,
      },
    });

    const result = await loadMissingItemPreviews([item]);
    const nextItem = result?.[0];

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/files/thumbnails', {
      method: 'POST',
      body: JSON.stringify({
        paths: [{
          gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
          mimeType: 'image/png',
        }],
      }),
    });
    expect(nextItem).toMatchObject({
      kind: 'assistant-turn',
      attachedFiles: [{
        fileName: 'artifact.png',
        preview: 'data:image/png;base64,abc',
        fileSize: 123,
        gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
      }],
    });
  });
});
