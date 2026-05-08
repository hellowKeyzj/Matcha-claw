import { describe, expect, it } from 'vitest';
import { hydrateAttachedFilesFromItems } from '@/stores/chat/attachment-helpers';
import type { SessionRenderItem } from '../../runtime-host/shared/session-adapter-types';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

describe('chat attachment helpers', () => {
  it('does not synthesize assistant attachments from raw absolute paths in assistant text', () => {
    const items = buildRenderItemsFromMessages('agent:test:main', [{
      role: 'assistant',
      content: ['path', 'E:\\code\\Matcha-claw\\browser.md'].join('\n'),
      id: 'assistant-1',
    }]);

    const hydrated = hydrateAttachedFilesFromItems(items);
    const assistant = hydrated[0];

    expect(assistant).toMatchObject({
      kind: 'assistant-turn',
      attachedFiles: [],
    });
  });

  it('keeps explicit authoritative attached files on user items and tags media refs as message-ref', () => {
    const items = buildRenderItemsFromMessages('agent:test:main', [{
      role: 'user',
      content: '[media attached: E:\\code\\Matcha-claw\\browser.md (text/markdown) | browser.md]',
      id: 'user-1',
      _attachedFiles: [{
        fileName: 'browser.md',
        mimeType: 'text/markdown',
        fileSize: 0,
        preview: null,
        filePath: 'E:\\code\\Matcha-claw\\browser.md',
        source: 'message-ref',
      }],
    }]) as SessionRenderItem[];

    const hydrated = hydrateAttachedFilesFromItems(items);
    const userItem = hydrated[0];

    expect(userItem).toMatchObject({
      kind: 'user-message',
      attachedFiles: [{
        fileName: 'browser.md',
        mimeType: 'text/markdown',
        fileSize: 0,
        preview: null,
        filePath: 'E:\\code\\Matcha-claw\\browser.md',
        source: 'message-ref',
      }],
    });
  });

  it('preserves tool-result attachment source on assistant items', () => {
    const items = buildRenderItemsFromMessages('agent:test:main', [{
      role: 'assistant',
      id: 'assistant-1',
      content: '结果如下。',
      _attachedFiles: [{
        fileName: 'artifact.png',
        mimeType: 'image/png',
        fileSize: 0,
        preview: 'data:image/png;base64,abc',
        filePath: 'E:\\code\\Matcha-claw\\artifact.png',
        source: 'tool-result',
      }],
    }]);

    const hydrated = hydrateAttachedFilesFromItems(items);
    const assistant = hydrated[0];

    expect(assistant).toMatchObject({
      kind: 'assistant-turn',
      attachedFiles: [{
        fileName: 'artifact.png',
        source: 'tool-result',
      }],
    });
  });
});
