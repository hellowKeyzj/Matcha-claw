import { describe, expect, it } from 'vitest';
import { readPatchSessionRequest } from '../../runtime-host/application/sessions/session-runtime-requests';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

describe('session runtime request parsing', () => {
  it('reads session model patch from runtimeModelRef and explicit SessionIdentity', () => {
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');

    expect(readPatchSessionRequest({
      sessionKey: 'agent:main:main',
      sessionIdentity,
      runtimeModelRef: 'anthropic/claude-opus-4-6',
      model: 'openai/gpt-5.4',
    })).toEqual({
      sessionKey: 'agent:main:main',
      sessionIdentity,
      sessionIdentityError: null,
      runtimeModelRef: 'anthropic/claude-opus-4-6',
    });

    expect(readPatchSessionRequest({
      sessionKey: 'agent:main:main',
      model: 'openai/gpt-5.4',
    })).toEqual({
      sessionKey: 'agent:main:main',
      sessionIdentity: null,
      sessionIdentityError: 'SessionIdentity is required',
      runtimeModelRef: '',
    });
  });

  it('rejects existing-session requests when sessionKey and SessionIdentity disagree', () => {
    expect(readPatchSessionRequest({
      sessionKey: 'agent:main:main',
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:other'),
      runtimeModelRef: 'anthropic/claude-sonnet-4-6',
    })).toEqual({
      sessionKey: 'agent:main:main',
      sessionIdentity: null,
      sessionIdentityError: 'sessionKey must match SessionIdentity.sessionKey',
      runtimeModelRef: 'anthropic/claude-sonnet-4-6',
    });
  });
});
