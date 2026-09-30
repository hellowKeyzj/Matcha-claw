import { describe, expect, it, vi } from 'vitest';

import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/issuer';
import { createProviderAccountsTransport } from '../../electron/main/runtime-host-delivery/transport/providers/accounts';

const listRequest = {
  id: 'provider.accounts' as const,
  operationId: 'providerAccounts.list' as const,
  scope: { kind: 'provider-account-catalog' as const },
  target: { kind: 'provider-accounts' as const },
  input: { kind: 'list' as const },
};

const replaceRequest = {
  id: 'provider.accounts' as const,
  operationId: 'providerAccounts.replace' as const,
  scope: { kind: 'provider-account-catalog' as const },
  target: { kind: 'provider-accounts' as const },
  input: {
    kind: 'replace' as const,
    account: {
      id: 'openai-main',
      provider: 'openai',
      label: 'OpenAI',
      enabled: true,
      kind: 'chat' as const,
      authMode: 'apiKey' as const,
      revision: 1,
    },
  },
};

describe('provider accounts delivery transport', () => {
  it('binds provider-account requests to the fixed localhost endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ accounts: [] }),
    });
    const transport = createProviderAccountsTransport(createRuntimeHostDeliveryIssuer(), 3240, fetcher);

    await expect(transport.execute(listRequest)).resolves.toEqual({ status: 200, body: { accounts: [] } });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3240/api/provider-accounts', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(listRequest),
    }));
    const authorization = fetcher.mock.calls[0]?.[1]?.headers.Authorization as string;
    const decision = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
    expect(JSON.parse(Buffer.from(decision, 'base64url').toString())).toMatchObject({
      endpoint: '/api/provider-accounts',
      scope: 'providers:accounts',
      capability: 'providerAccounts.list',
      subject: 'provider-accounts',
    });
  });

  it('accepts only non-secret account facts and rejects secret-bearing input before dispatch', async () => {
    const fetcher = vi.fn();
    const transport = createProviderAccountsTransport(createRuntimeHostDeliveryIssuer(), 3240, fetcher);

    for (const secretBearingAccount of [
      { ...replaceRequest.input.account, apiKey: 'secret-canary' },
      { ...replaceRequest.input.account, credentialReference: 'credential:v1:openai-main' },
    ]) {
      await expect(transport.execute({
        ...replaceRequest,
        input: { ...replaceRequest.input, account: secretBearingAccount },
      })).resolves.toEqual({
        status: 400,
        body: { success: false, error: 'Provider account request is invalid' },
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves custom media endpoint and protocol without accepting auth fields', async () => {
    const receipt = { callId: 'a'.repeat(32), accepted: true } as const;
    const fetcher = vi.fn().mockResolvedValue({
      status: 202,
      json: async () => receipt,
    });
    const transport = createProviderAccountsTransport(createRuntimeHostDeliveryIssuer(), 3240, fetcher);
    const account = {
      ...replaceRequest.input.account,
      id: 'custom-media',
      provider: 'custom',
      kind: 'media' as const,
      endpoint: 'https://media.example.test/v1',
      mediaProtocol: 'openRouter' as const,
    };

    await expect(transport.execute({
      ...replaceRequest,
      input: { kind: 'replace', account },
    })).resolves.toEqual({ status: 202, body: receipt });
    expect(fetcher.mock.calls[0]?.[1]?.body).toContain('https://media.example.test/v1');
  });

  it('redacts malformed or unavailable native responses', async () => {
    const transport = createProviderAccountsTransport(
      createRuntimeHostDeliveryIssuer(),
      3240,
      vi.fn().mockResolvedValue({
        status: 202,
        json: async () => ({ callId: 'a'.repeat(32), accepted: true, account: { ...replaceRequest.input.account, accessToken: 'secret-canary' } }),
      }),
    );

    await expect(transport.execute(replaceRequest)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Provider accounts are unavailable' },
    });
  });
});
