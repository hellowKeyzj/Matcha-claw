import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamRoleChatRoutes } from '../../electron/api/routes/team-role-chat';

function request(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

const roleChat = {
  teamId: 'team-1',
  runId: 'run-1',
  roleId: 'leader',
  message: 'private message canary',
  idempotencyKey: 'role-chat-1',
};

describe('Team role-chat Host API route', () => {
  it('forwards the exact public DTO to its dedicated transport', async () => {
    const submit = vi.fn().mockResolvedValue({
      status: 200,
      body: { success: true, outcome: 'accepted' },
    });
    const result = response();

    await expect(handleTeamRoleChatRoutes(
      request(roleChat) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/team/role-chat'),
      { submit },
    )).resolves.toBe(true);

    expect(submit).toHaveBeenCalledWith(roleChat);
    expect(result.state).toEqual({
      statusCode: 200,
      body: { success: true, outcome: 'accepted' },
    });
  });

  it('rejects unknown fields, oversized message bodies, and other methods', async () => {
    const submit = vi.fn();
    for (const [body, method] of [
      [{ ...roleChat, nativeReceipt: 'private' }, 'POST'],
      [{ ...roleChat, message: 'x'.repeat(16 * 1024 + 1) }, 'POST'],
      [roleChat, 'GET'],
    ] as const) {
      const result = response();
      await handleTeamRoleChatRoutes(
        request(body, method) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/role-chat'),
        { submit },
      );
      if (method === 'POST') {
        expect(result.state).toEqual({
          statusCode: 400,
          body: { success: false, error: 'Team role chat request is invalid' },
        });
      }
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not claim the removed worker capability route', async () => {
    await expect(handleTeamRoleChatRoutes(
      request(roleChat) as never,
      response().raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { submit: vi.fn() },
    )).resolves.toBe(false);
  });
});
