import { describe, expect, it } from 'vitest';
import { extractMessageText, normalizeMessageRole } from '../../src/stores/chat/message-content';
import {
  sanitizeAssistantDisplayText,
  sanitizeCanonicalUserText,
} from '../../src/stores/chat/message-display';
import { normalizeRawChatMessage } from '../../src/stores/chat/message-identity';
import {
  isAssistantControlPrefixMessage,
  isInternalRuntimeDisplayMessage,
  shouldPreserveCanonicalTranscriptMessage,
} from '../../src/stores/chat/message-filter';

describe('chat message normalization', () => {
  it('normalizes message content roles and text blocks', () => {
    expect(normalizeMessageRole('TOOL_RESULT')).toBe('tool_result');
    expect(extractMessageText([{ type: 'text', text: 'first' }, { type: 'image', text: 'ignored' }, { type: 'text', text: 'second' }])).toBe('first\nsecond');
  });

  it('normalizes canonical message identity and user content', () => {
    expect(normalizeRawChatMessage({
      role: 'USER',
      id: ' id-1 ',
      parent_message_id: ' parent-1 ',
      idempotency_key: ' client-1 ',
      content: '[Bootstrap pending]\nPlease read BOOTSTRAP.md from the workspace and follow it before replying normally.\n\n在吗',
    }, {
      sanitizeCanonicalUser: true,
      fallbackMessageIdToId: true,
      fallbackOriginMessageIdToParentMessageId: true,
    })).toMatchObject({
      role: 'user',
      id: 'id-1',
      messageId: 'id-1',
      originMessageId: 'parent-1',
      clientId: 'client-1',
      content: '在吗',
    });
  });

  it('filters runtime system injection bundles from canonical transcript preservation', () => {
    const message = {
      role: 'user',
      content: [{
        type: 'text',
        text: [
          'System (untrusted): [2026-04-22 10:06:24 GMT+8] Exec completed (nimbler, code 0) ...',
          'An async command you ran earlier has completed. The result is shown in the system messages above. Handle the result internally. Do not relay it to the user unless explicitly requested.',
          'Current time: Wednesday, April 22nd, 2026 - 10:06 (Asia/Shanghai) / 2026-04-22 02:06 UTC',
        ].join('\n\n'),
      }],
    };

    expect(isInternalRuntimeDisplayMessage(message)).toBe(true);
    expect(shouldPreserveCanonicalTranscriptMessage(message)).toBe(false);
  });

  it('filters standalone current-time runtime pings', () => {
    const message = {
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'Current time: Wednesday, April 22nd, 2026 - 10:06 (Asia/Shanghai) / 2026-04-22 02:06 UTC',
      }],
    };

    expect(isInternalRuntimeDisplayMessage(message)).toBe(true);
    expect(shouldPreserveCanonicalTranscriptMessage(message)).toBe(false);
  });

  it('does not filter normal user text that only starts with current time', () => {
    const message = {
      role: 'user',
      content: [{
        type: 'text',
        text: 'Current time: 北京现在几点？',
      }],
    };

    expect(isInternalRuntimeDisplayMessage(message)).toBe(false);
    expect(shouldPreserveCanonicalTranscriptMessage(message)).toBe(true);
  });

  it('strips bootstrap and channel metadata from displayed external user messages', () => {
    const text = [
      '[Bootstrap pending]',
      'Please read BOOTSTRAP.md from the workspace and follow it before replying normally.',
      'Do not pretend bootstrap is complete when it is not.',
      '',
      'Conversation info (untrusted metadata):',
      '```json',
      '{',
      '  "chat_id": "user_1",',
      '  "message_id": "msg_1"',
      '}',
      '```',
      '',
      'Sender (untrusted metadata):',
      '```json',
      '{',
      '  "id": "user_1",',
      '  "name": "user_1"',
      '}',
      '```',
      '',
      '在吗',
    ].join('\n');

    expect(sanitizeCanonicalUserText(text)).toBe('在吗');
  });

  it('strips channel system envelopes and metadata from displayed external user messages', () => {
    const text = [
      'System: [2026-05-18 01:07:22 GMT+8] Feishu[default] DM | ou_41b96165b0b61187832087517df1deed [msg:om_x100b6fab12662468b3704885b5c1abf]',
      '',
      'Conversation info (untrusted metadata):',
      '```json',
      '{',
      '  "chat_id": "user:ou_41b96165b0b61187832087517df1deed",',
      '  "message_id": "om_x100b6fab12662468b3704885b5c1abf"',
      '}',
      '```',
      '',
      'Sender (untrusted metadata):',
      '```json',
      '{',
      '  "id": "ou_41b96165b0b61187832087517df1deed"',
      '}',
      '```',
      '',
      '在吗',
    ].join('\n');

    expect(sanitizeCanonicalUserText(text)).toBe('在吗');
  });

  it('strips OpenClaw ctx sender metadata from displayed external user messages', () => {
    const text = [
      'Sender: ⟦openclaw:ctx⟧',
      '```json',
      '{',
      '  "label": "MatchaClaw Runtime Host (gateway-client)",',
      '  "id": "gateway-client",',
      '  "name": "MatchaClaw Runtime Host",',
      '  "username": "MatchaClaw Runtime Host"',
      '}',
      '```',
      '',
      '[Fri 2026-08-21 16:28 GMT+8] 你好',
    ].join('\n');

    expect(sanitizeCanonicalUserText(text)).toBe('你好');
  });

  it('does not strip normal user text that mentions System', () => {
    const text = 'System: 这是我要发给模型看的普通文本，不是渠道消息信封。';

    expect(sanitizeCanonicalUserText(text)).toBe(text);
  });

  it('treats pure bootstrap and metadata bundles as internal display messages', () => {
    const message = {
      role: 'user',
      content: [{
        type: 'text',
        text: [
          '[Bootstrap pending]',
          'Please read BOOTSTRAP.md from the workspace and follow it before replying normally.',
          'Do not use a generic first greeting or reply normally until after you have handled BOOTSTRAP.md.',
          '',
          'Sender (untrusted metadata):',
          '```json',
          '{ "id": "gateway-client" }',
          '```',
        ].join('\n'),
      }],
    };

    expect(isInternalRuntimeDisplayMessage(message)).toBe(true);
    expect(shouldPreserveCanonicalTranscriptMessage(message)).toBe(false);
  });

  it('treats pure channel envelopes and metadata bundles as internal display messages', () => {
    const message = {
      role: 'user',
      content: [{
        type: 'text',
        text: [
          'System: [2026-05-18 01:07:22 GMT+8] Feishu[default] DM | ou_41b96165b0b61187832087517df1deed [msg:om_x100b6fab12662468b3704885b5c1abf]',
          '',
          'Conversation info (untrusted metadata):',
          '```json',
          '{ "message_id": "om_x100b6fab12662468b3704885b5c1abf" }',
          '```',
          '',
          'Sender (untrusted metadata):',
          '```json',
          '{ "id": "ou_41b96165b0b61187832087517df1deed" }',
          '```',
        ].join('\n'),
      }],
    };

    expect(isInternalRuntimeDisplayMessage(message)).toBe(true);
    expect(shouldPreserveCanonicalTranscriptMessage(message)).toBe(false);
  });

  it('treats OpenClaw gateway restart recovery prompts as internal display messages', () => {
    const text = '[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response. Treat a tool result marked interrupted or missing as having an unknown outcome. If a tool failed, say so; never claim completion or success.';
    const message = {
      role: 'user',
      content: [{
        type: 'text',
        text,
      }],
    };

    expect(sanitizeCanonicalUserText(text)).toBe('');
    expect(isInternalRuntimeDisplayMessage(message)).toBe(true);
    expect(shouldPreserveCanonicalTranscriptMessage(message)).toBe(false);
  });

  it('filters assistant NO_REPLY but keeps user NO_REPLY', () => {
    const assistant = {
      role: 'assistant',
      content: [{ type: 'text', text: 'NO_REPLY' }],
    };
    const user = {
      role: 'user',
      content: [{ type: 'text', text: 'NO_REPLY' }],
    };

    expect(isInternalRuntimeDisplayMessage(assistant)).toBe(true);
    expect(shouldPreserveCanonicalTranscriptMessage(assistant)).toBe(false);
    expect(isInternalRuntimeDisplayMessage(user)).toBe(false);
    expect(shouldPreserveCanonicalTranscriptMessage(user)).toBe(true);
  });

  it('uses assistant text field before content for silent-reply checks', () => {
    const message = {
      role: 'assistant',
      text: 'real reply',
      content: 'NO_REPLY',
    };

    expect(isInternalRuntimeDisplayMessage(message)).toBe(false);
    expect(shouldPreserveCanonicalTranscriptMessage(message)).toBe(true);
  });

  it('strips assistant control and artifact markers from visible assistant text', () => {
    expect(sanitizeAssistantDisplayText([
      'Real reply',
      'NO_REPLY',
      '',
      String.raw`MEDIA:C:\Users\me\.openclaw\workspace\out.svg`,
      String.raw`Inline MEDIA:C:\Users\me\.openclaw\workspace\inline.svg done`,
      String.raw`Bare C:\Users\me\.openclaw\media\artifact.svg path`,
      'More detail',
      'HEARTBEAT_OK',
    ].join('\n'))).toBe([
      'Real reply',
      '',
      'Inline  done',
      'Bare  path',
      'More detail',
    ].join('\n'));
  });

  it('preserves assistant markdown block boundaries while trimming edges', () => {
    expect(sanitizeAssistantDisplayText([
      '',
      '| Column | Value |',
      '| --- | --- |',
      '| A | B |',
      '',
      'Normal paragraph.',
      '',
    ].join('\n'))).toBe([
      '| Column | Value |',
      '| --- | --- |',
      '| A | B |',
      '',
      'Normal paragraph.',
    ].join('\n'));
  });

  it('strips internal delivery planning and loose media markers from assistant text', () => {
    expect(sanitizeAssistantDisplayText([
      'The message tool isn\'t suitable here, so I will fall back to writing the normal final reply with MEDIA directives.',
      '',
      'Real reply',
      String.raw`必备~MEDIA:C:\Users\me\.openclaw\workspace\space name.svg done`,
      String.raw`Bare C:\Users\me\.openclaw\media\artifact with spaces.svg path`,
    ].join('\n'))).toBe([
      'Real reply',
      '必备~ done',
      'Bare  path',
    ].join('\n'));
  });

  it('filters standalone internal delivery planning messages', () => {
    const message = {
      role: 'assistant',
      content: 'Webchat isn\'t a valid channel for the message tool. Fall back to writing the normal final reply.',
    };

    expect(isInternalRuntimeDisplayMessage(message)).toBe(true);
    expect(shouldPreserveCanonicalTranscriptMessage(message)).toBe(false);
  });

  it('detects only uppercase silent reply streaming prefixes for assistant messages', () => {
    expect(isAssistantControlPrefixMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'NO' }],
    })).toBe(true);
    expect(isAssistantControlPrefixMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'NO_R' }],
    })).toBe(true);
    expect(isAssistantControlPrefixMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'No, that is fine.' }],
    })).toBe(false);
    expect(isAssistantControlPrefixMessage({
      role: 'user',
      content: [{ type: 'text', text: 'NO' }],
    })).toBe(false);
  });
});
