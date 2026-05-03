import { describe, expect, it } from 'vitest';
import { hydrateAttachedFilesFromTimelineEntries } from '@/stores/chat/attachment-helpers';
import type { SessionTimelineEntry } from '../../runtime-host/shared/session-adapter-types';

function buildEntry(input: Partial<SessionTimelineEntry>): SessionTimelineEntry {
  const role = input.role ?? 'assistant';
  const entryId = input.entryId ?? 'entry-1';
  return {
    entryId,
    sessionKey: 'agent:test:main',
    laneKey: 'main',
    turnKey: `main:${entryId}`,
    role,
    status: 'final',
    text: '',
    message: {
      role,
      content: '',
      ...input.message,
    },
    ...input,
  };
}

describe('chat attachment helpers', () => {
  it('does not synthesize assistant attachments from raw absolute paths in assistant text', () => {
    const entries = [buildEntry({
      entryId: 'assistant-1',
      role: 'assistant',
      message: {
        role: 'assistant',
        content: ['path', 'E:\\code\\Matcha-claw\\browser.md'].join('\n'),
      },
    })];

    const hydrated = hydrateAttachedFilesFromTimelineEntries(entries);

    expect(hydrated[0]?.message._attachedFiles).toBeUndefined();
  });

  it('keeps explicit authoritative attached files on user entries', () => {
    const entries = [buildEntry({
      entryId: 'user-1',
      role: 'user',
      message: {
        role: 'user',
        content: '[media attached: E:\\code\\Matcha-claw\\browser.md (text/markdown) | browser.md]',
        _attachedFiles: [{
          fileName: 'browser.md',
          mimeType: 'text/markdown',
          fileSize: 0,
          preview: null,
          filePath: 'E:\\code\\Matcha-claw\\browser.md',
        }],
      },
    })];

    const hydrated = hydrateAttachedFilesFromTimelineEntries(entries);

    expect(hydrated[0]?.message._attachedFiles).toEqual([{
      fileName: 'browser.md',
      mimeType: 'text/markdown',
      fileSize: 0,
      preview: null,
      filePath: 'E:\\code\\Matcha-claw\\browser.md',
    }]);
  });

  it('keeps structured tool-result images as assistant timeline attachments', () => {
    const entries = [
      buildEntry({
        entryId: 'toolresult-1',
        role: 'toolresult',
        message: {
          role: 'toolresult',
          toolCallId: 'tool-call-1',
          content: [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
        },
      }),
      buildEntry({
        entryId: 'assistant-1',
        role: 'assistant',
        message: { role: 'assistant', content: '结果如下。' },
      }),
    ];

    const hydrated = hydrateAttachedFilesFromTimelineEntries(entries);

    expect(hydrated[1]?.message._attachedFiles).toEqual([{
      fileName: 'image',
      mimeType: 'image/png',
      fileSize: 0,
      preview: 'data:image/png;base64,abc',
    }]);
  });
});
