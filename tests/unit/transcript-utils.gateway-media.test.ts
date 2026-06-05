import { describe, expect, it } from 'vitest';
import { buildCanonicalReplayEventsFromTranscriptMessages } from '../../runtime-host/application/sessions/canonical/canonical-transcript-replay';
import { buildRenderItemsFromCanonicalState } from '../../runtime-host/application/sessions/canonical/canonical-projection';
import { createEmptyCanonicalSessionState, reduceCanonicalSessionEvents } from '../../runtime-host/application/sessions/canonical/canonical-reducer';
import { createOpenClawTestRuntimeContext, openClawTestRuntimeIdentity } from './helpers/runtime-address-fixtures';

describe('transcript utils gateway media', () => {
  it('keeps assistant gateway media bubbles as renderable assistant turns', () => {
    const state = createEmptyCanonicalSessionState('agent:test:main', createOpenClawTestRuntimeContext('agent:test:main'));
    reduceCanonicalSessionEvents(state, buildCanonicalReplayEventsFromTranscriptMessages('agent:test:main', [{
      role: 'assistant',
      id: 'assistant-media-1',
      content: [{
        type: 'image',
        url: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
        mimeType: 'image/png',
        alt: 'artifact.png',
      }],
    }], openClawTestRuntimeIdentity));

    const turn = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] })[0];

    expect(turn).toMatchObject({
      kind: 'assistant-turn',
      text: '',
      attachedFiles: [{
        fileName: 'artifact.png',
        gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
      }],
      segments: [expect.objectContaining({
        kind: 'media',
        attachedFiles: [expect.objectContaining({
          fileName: 'artifact.png',
          mimeType: 'image/png',
          gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
        })],
      })],
    });
  });

  it('hides Windows MEDIA artifact marker text while surfacing the SVG attachment', () => {
    const state = createEmptyCanonicalSessionState('agent:test:main', createOpenClawTestRuntimeContext('agent:test:main'));
    const filePath = String.raw`C:\Users\Administrator\.openclaw\workspace\plan.svg`;
    reduceCanonicalSessionEvents(state, buildCanonicalReplayEventsFromTranscriptMessages('agent:test:main', [{
      role: 'assistant',
      id: 'assistant-media-windows-svg',
      content: `SVG file is ready:\n\nMEDIA:${filePath}`,
    }], openClawTestRuntimeIdentity));

    const turn = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] })[0];

    expect(turn).toMatchObject({
      kind: 'assistant-turn',
      text: 'SVG file is ready:',
      attachedFiles: [{
        fileName: 'plan.svg',
        mimeType: 'image/svg+xml',
        filePath,
      }],
    });
    expect(turn && 'segments' in turn ? turn.segments : []).toEqual([
      expect.objectContaining({ kind: 'message', text: 'SVG file is ready:' }),
      expect.objectContaining({
        kind: 'media',
        attachedFiles: [expect.objectContaining({ fileName: 'plan.svg' })],
      }),
    ]);
  });
});
