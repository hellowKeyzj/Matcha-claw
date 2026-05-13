import { describe, expect, it } from 'vitest';
import {
  isAssistantControlPrefixMessage,
  isInternalRuntimeDisplayMessage,
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
