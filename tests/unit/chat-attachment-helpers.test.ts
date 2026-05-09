import { describe, expect, it } from 'vitest';
import {
  hydrateAttachedFilesFromItems,
  reconcileHydratedAttachmentItems,
} from '@/stores/chat/attachment-helpers';
import { reconcileSessionItems } from '@/stores/chat/store-state-helpers';
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

  it('reuses unchanged items by key and replaces only semantic changes', () => {
    const currentItems = buildRenderItemsFromMessages('agent:test:main', [
      {
        role: 'user',
        content: 'hello',
        id: 'user-1',
        timestamp: 1,
      },
      {
        role: 'assistant',
        content: 'world',
        id: 'assistant-1',
        timestamp: 2,
      },
    ]) as SessionRenderItem[];
    const nextItems = buildRenderItemsFromMessages('agent:test:main', [
      {
        role: 'assistant',
        content: 'world updated',
        id: 'assistant-1',
        timestamp: 2,
      },
      {
        role: 'user',
        content: 'hello',
        id: 'user-1',
        timestamp: 1,
      },
    ]) as SessionRenderItem[];

    const reconciled = reconcileSessionItems(currentItems, nextItems);

    expect(reconciled).toHaveLength(2);
    expect(reconciled[0]).toBe(nextItems[0]);
    expect(reconciled[1]).toBe(currentItems[0]);
    expect(reconciled.map((item) => item.key)).toEqual(nextItems.map((item) => item.key));
  });

  it('keeps newer snapshot items when old hydrated previews resolve later', () => {
    const currentItems = buildRenderItemsFromMessages('agent:test:main', [
      {
        role: 'assistant',
        content: 'old assistant',
        id: 'assistant-1',
        timestamp: 1,
        _attachedFiles: [{
          fileName: 'artifact.png',
          mimeType: 'image/png',
          fileSize: 0,
          preview: null,
          filePath: 'E:\\code\\Matcha-claw\\artifact.png',
          source: 'tool-result',
        }],
      },
      {
        role: 'user',
        content: 'new user',
        id: 'user-2',
        timestamp: 2,
      },
    ]) as SessionRenderItem[];
    const hydratedOldItems = buildRenderItemsFromMessages('agent:test:main', [
      {
        role: 'assistant',
        content: 'old assistant',
        id: 'assistant-1',
        timestamp: 1,
        _attachedFiles: [{
          fileName: 'artifact.png',
          mimeType: 'image/png',
          fileSize: 123,
          preview: 'data:image/png;base64,abc',
          filePath: 'E:\\code\\Matcha-claw\\artifact.png',
          source: 'tool-result',
        }],
      },
    ]) as SessionRenderItem[];

    const reconciled = reconcileHydratedAttachmentItems(currentItems, hydratedOldItems);

    expect(reconciled).toHaveLength(2);
    expect(reconciled[0]).not.toBe(currentItems[0]);
    expect(reconciled[0]).toMatchObject({
      kind: 'assistant-turn',
      attachedFiles: [{
        fileName: 'artifact.png',
        fileSize: 123,
        preview: 'data:image/png;base64,abc',
      }],
    });
    expect(reconciled[1]).toBe(currentItems[1]);
    expect(reconciled[1]).toMatchObject({
      kind: 'user-message',
      text: 'new user',
    });
  });
});
