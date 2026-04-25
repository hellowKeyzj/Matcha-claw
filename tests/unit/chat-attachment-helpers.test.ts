import { describe, expect, it } from 'vitest';
import {
  enrichWithCachedImages,
  enrichWithToolResultFiles,
} from '@/stores/chat/attachment-helpers';
import type { RawMessage } from '@/stores/chat/types';

describe('chat attachment helpers', () => {
  it('does not synthesize assistant attachments from raw absolute paths in assistant text', () => {
    const messages: RawMessage[] = [
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          'Windows 下 browser navigate 异常',
          '',
          "这个 Only URLs with a scheme... Received protocol 'e:' 很值得重点查",
          '看起来像某个本地路径被当成 ESM loader 输入了',
          'E:\\code\\Matcha-claw\\browser.md',
        ].join('\n'),
      },
    ];

    const enriched = enrichWithCachedImages(messages);

    expect(enriched[0]?._attachedFiles).toBeUndefined();
  });

  it('does not inherit raw absolute paths from the previous user message into assistant attachments', () => {
    const messages: RawMessage[] = [
      {
        role: 'user',
        id: 'user-1',
        content: '请帮我看这个文件 E:\\code\\Matcha-claw\\browser.md',
      },
      {
        role: 'assistant',
        id: 'assistant-1',
        content: '我先帮你看原因。',
      },
    ];

    const enriched = enrichWithCachedImages(messages);

    expect(enriched[1]?._attachedFiles).toBeUndefined();
  });

  it('keeps explicit media-attached references as attached files', () => {
    const messages: RawMessage[] = [
      {
        role: 'user',
        id: 'user-1',
        content: '[media attached: E:\\code\\Matcha-claw\\browser.md (text/markdown) | browser.md]',
      },
    ];

    const enriched = enrichWithCachedImages(messages);

    expect(enriched[0]?._attachedFiles).toEqual([
      {
        fileName: 'browser.md',
        mimeType: 'text/markdown',
        fileSize: 0,
        preview: null,
        filePath: 'E:\\code\\Matcha-claw\\browser.md',
      },
    ]);
  });

  it('keeps structured tool-result images as assistant attachments', () => {
    const messages: RawMessage[] = [
      {
        role: 'toolresult',
        id: 'toolresult-1',
        toolCallId: 'tool-call-1',
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'abc',
          },
        ],
      },
      {
        role: 'assistant',
        id: 'assistant-1',
        content: '结果如下。',
      },
    ];

    const enriched = enrichWithToolResultFiles(messages);

    expect(enriched[1]?._attachedFiles).toEqual([
      {
        fileName: 'image',
        mimeType: 'image/png',
        fileSize: 0,
        preview: 'data:image/png;base64,abc',
      },
    ]);
  });
});
