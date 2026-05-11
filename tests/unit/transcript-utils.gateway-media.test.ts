import { describe, expect, it } from 'vitest';
import { assembleAuthoritativeAssistantTurns } from '../../runtime-host/application/sessions/assistant-turn-assembler';
import { buildTimelineEntriesFromTranscriptMessage } from '../../runtime-host/application/sessions/transcript-timeline-materializer';

describe('transcript utils gateway media', () => {
  it('keeps assistant gateway media bubbles as renderable assistant turns', () => {
    const rows = buildTimelineEntriesFromTranscriptMessage('agent:test:main', {
      role: 'assistant',
      id: 'assistant-media-1',
      content: [{
        type: 'image',
        url: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
        mimeType: 'image/png',
        alt: 'artifact.png',
      }],
    }, {
      index: 0,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'message',
      text: '',
      attachedFiles: [{
        fileName: 'artifact.png',
        mimeType: 'image/png',
        gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
      }],
    });

    const assembly = assembleAuthoritativeAssistantTurns({
      sessionKey: 'agent:test:main',
      timelineEntries: rows,
      runtime: {
        sending: false,
        activeRunId: null,
        runPhase: 'idle',
        activeTurnItemKey: null,
        pendingTurnKey: null,
        pendingTurnLaneKey: null,
        pendingFinal: false,
        lastUserMessageAt: null,
        lastError: null,
        lastIssue: null,
        updatedAt: null,
      },
    });
    const turn = Array.from(assembly.turnsByLatestTimelineKey.values())[0];

    expect(turn).toMatchObject({
      kind: 'assistant-turn',
      text: '',
      attachedFiles: [{
        fileName: 'artifact.png',
        gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
      }],
    });
    expect(turn?.segments).toEqual([
      expect.objectContaining({
        kind: 'media',
        attachedFiles: [
          expect.objectContaining({
            gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
          }),
        ],
      }),
    ]);
  });
});
