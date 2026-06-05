import { describe, expect, it } from 'vitest';
import {
  isAssistantControlPrefixMessage,
  isInternalRuntimeDisplayMessage,
  sanitizeAssistantDisplayText,
  sanitizeCanonicalUserText,
  shouldPreserveCanonicalTranscriptMessage,
} from '../../runtime-host/shared/chat-message-normalization';

describe('chat message normalization', () => {
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

  it('strips standalone assistant control and artifact marker lines from visible assistant text', () => {
    expect(sanitizeAssistantDisplayText([
      'Real reply',
      'NO_REPLY',
      '',
      String.raw`MEDIA:C:\Users\me\.openclaw\workspace\out.svg`,
      'More detail',
      'HEARTBEAT_OK',
    ].join('\n'))).toBe([
      'Real reply',
      'More detail',
    ].join('\n'));
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
