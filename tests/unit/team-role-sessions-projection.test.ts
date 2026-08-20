import { describe, expect, it, vi } from 'vitest';
import { decodeTeamRoleSessions, readTeamRoleSessions } from '@/services/team-role-sessions';
import { hostApiFetchDecoded } from '@/lib/host-api';

vi.mock('@/lib/host-api', () => ({
  hostApiFetchDecoded: vi.fn(),
}));

const projection = {
  success: true,
  sessions: [{
    teamId: 'team-1',
    runId: 'run-1',
    roleId: 'leader',
    sessionRef: 'local:opaque-1',
    status: 'available',
  }],
};

describe('Team role-session renderer projection', () => {
  it('uses the sealed request and fixed role-session route', async () => {
    vi.mocked(hostApiFetchDecoded).mockResolvedValueOnce(projection.sessions);

    await expect(readTeamRoleSessions({ teamId: 'team-1' })).resolves.toEqual(projection.sessions);
    expect(hostApiFetchDecoded).toHaveBeenCalledWith(
      '/api/team/role-sessions',
      decodeTeamRoleSessions,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: 'team-1' }),
      },
    );
  });

  it('rejects private session identity and native endpoint fields', () => {
    expect(decodeTeamRoleSessions(projection)).toEqual(projection.sessions);
    expect(() => decodeTeamRoleSessions({
      ...projection,
      sessions: [{ ...projection.sessions[0], sessionIdentity: { sessionKey: 'native-private-id' } }],
    })).toThrow('Invalid Team role-session projection');
    expect(() => decodeTeamRoleSessions({
      ...projection,
      sessions: [{ ...projection.sessions[0], endpointSessionId: 'native-private-id' }],
    })).toThrow('Invalid Team role-session projection');
  });
});
