import { describe, expect, it } from 'vitest';
import { readPatchSessionRequest } from '../../runtime-host/application/sessions/session-runtime-requests';

describe('session runtime request parsing', () => {
  it('reads session model patch from runtimeModelRef only', () => {
    expect(readPatchSessionRequest({
      sessionKey: 'agent:main:main',
      runtimeModelRef: 'anthropic/claude-opus-4-6',
      model: 'openai/gpt-5.4',
    })).toEqual({
      sessionKey: 'agent:main:main',
      runtimeModelRef: 'anthropic/claude-opus-4-6',
    });

    expect(readPatchSessionRequest({
      sessionKey: 'agent:main:main',
      model: 'openai/gpt-5.4',
    })).toEqual({
      sessionKey: 'agent:main:main',
      runtimeModelRef: '',
    });
  });
});
