import { describe, expect, it } from 'vitest';
import { readPatchSessionRequest } from '../../runtime-host/application/sessions/session-runtime-requests';
import { createOpenClawTestRuntimeAddress } from './helpers/runtime-address-fixtures';

describe('session runtime request parsing', () => {
  it('reads session model patch from runtimeModelRef and explicit RuntimeAddress', () => {
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');

    expect(readPatchSessionRequest({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      runtimeModelRef: 'anthropic/claude-opus-4-6',
      model: 'openai/gpt-5.4',
    })).toEqual({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      runtimeAddressError: null,
      runtimeModelRef: 'anthropic/claude-opus-4-6',
    });

    expect(readPatchSessionRequest({
      sessionKey: 'agent:main:main',
      model: 'openai/gpt-5.4',
    })).toEqual({
      sessionKey: 'agent:main:main',
      runtimeAddress: null,
      runtimeAddressError: 'RuntimeAddress is required',
      runtimeModelRef: '',
    });
  });
});
