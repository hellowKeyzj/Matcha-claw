import { describe, expect, it } from 'vitest';
import { extractEntryText } from '@/pages/Chat/message-utils';
import type { SessionTimelineEntry } from '../../runtime-host/shared/session-adapter-types';

function buildEntry(input: {
  role: SessionTimelineEntry['role'];
  content: unknown;
  text?: string;
}): SessionTimelineEntry {
  return {
    entryId: 'entry-1',
    sessionKey: 'agent:main:test',
    laneKey: 'main',
    turnKey: 'main:entry-1',
    role: input.role,
    status: 'final',
    text: input.text ?? '',
    message: {
      role: input.role,
      content: input.content,
    },
  };
}

describe('chat message utils', () => {
  it('strips sender untrusted metadata block from user timeline entries', () => {
    const text = extractEntryText(buildEntry({
      role: 'user',
      content: [{
        type: 'text',
        text: [
          'Sender (untrusted metadata):',
          '```json',
          '{ id: gateway-client }',
          '```',
          '[Tue 2026-04-14 00:11 GMT+8]hello',
        ].join('\n'),
      }],
    }));

    expect(text).toBe('hello');
  });

  it('strips assistant reply directive prefix', () => {
    const text = extractEntryText(buildEntry({
      role: 'assistant',
      content: '[[reply_to:f4a00548-42a8-4826-8e45-0a655d7c6414]]ok',
    }));

    expect(text).toBe('ok');
  });
});
