import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamSkillRoutes } from '../../electron/api/routes/team-skill';

const selectionId = `teamskill:v1:${'a'.repeat(64)}`;
const teamId = 'team:writing';
const idempotencyKey = 'materialize:writing:1';

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

describe('TeamSkill Host API route', () => {
  it('forwards authorization only through the dedicated transport', async () => {
    const authorize = vi.fn().mockResolvedValue({ status: 200, body: { selectionId } });
    const result = response();

    await expect(handleTeamSkillRoutes(
      request({ operation: 'team.skill.authorize', packageRoot: 'E:/skills/writing' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/team/skill'),
      { authorize, validate: vi.fn(), dependencyPlan: vi.fn() },
    )).resolves.toBe(true);

    expect(authorize).toHaveBeenCalledWith('E:/skills/writing');
    expect(result.state).toEqual({ statusCode: 200, body: { selectionId } });
  });

  it('forwards only a selection identifier for validate and dependency plan', async () => {
    const validate = vi.fn().mockResolvedValue({ status: 200, body: { status: 'invalid' } });
    const dependencyPlan = vi.fn().mockResolvedValue({ status: 200, body: { status: 'unavailable' } });

    for (const [operation, handler] of [
      ['team.skill.validate', validate],
      ['team.skill.dependency-plan', dependencyPlan],
    ] as const) {
      const result = response();
      await handleTeamSkillRoutes(
        request({ operation, selectionId }) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/skill'),
        { authorize: vi.fn(), validate, dependencyPlan },
      );
      expect(handler).toHaveBeenCalledWith(selectionId);
      expect(result.state.statusCode).toBe(200);
    }
  });

  it('forwards only materialize identifiers through the dedicated transport', async () => {
    const materialize = vi.fn().mockResolvedValue({ status: 200, body: { status: 'materialized' } });
    const result = response();

    await handleTeamSkillRoutes(
      request({ operation: 'team.skill.materialize', selectionId, teamId, idempotencyKey }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/team/skill'),
      { authorize: vi.fn(), validate: vi.fn(), dependencyPlan: vi.fn(), materialize },
    );

    expect(materialize).toHaveBeenCalledWith(selectionId, teamId, idempotencyKey);
    expect(result.state).toEqual({ statusCode: 200, body: { status: 'materialized' } });
  });

  it('rejects raw roots and extra fields without transport calls', async () => {
    const transport = { authorize: vi.fn(), validate: vi.fn(), dependencyPlan: vi.fn(), materialize: vi.fn() };
    for (const body of [
      { operation: 'team.skill.validate', packageRoot: 'E:/private' },
      { operation: 'team.skill.dependency-plan', selectionId, packageRoot: 'E:/private' },
      { operation: 'team.skill.authorize', packageRoot: 'E:/skills/writing', sourcePath: 'E:/private' },
      { operation: 'team.skill.materialize', selectionId, teamId, idempotencyKey, packagePath: 'E:/private' },
      { operation: 'team.skill.materialize', selectionId, teamId, idempotencyKey, sourcePath: 'E:/private' },
      { operation: 'team.skill.materialize', selectionId, teamId, idempotencyKey, role: 'writer' },
      { operation: 'team.skill.materialize', selectionId, teamId, idempotencyKey, workspace: 'E:/private' },
      { operation: 'team.skill.materialize', selectionId, teamId: 'team/invalid', idempotencyKey },
      { operation: 'team.skill.materialize', selectionId, teamId, idempotencyKey: 'not allowed' },
    ]) {
      const result = response();
      await handleTeamSkillRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/skill'),
        transport,
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'TeamSkill selection request is invalid' },
      });
    }
    expect(transport.authorize).not.toHaveBeenCalled();
    expect(transport.validate).not.toHaveBeenCalled();
    expect(transport.dependencyPlan).not.toHaveBeenCalled();
    expect(transport.materialize).not.toHaveBeenCalled();
  });

  it('does not claim unrelated routes', async () => {
    await expect(handleTeamSkillRoutes(
      request({ operation: 'team.skill.validate', selectionId }) as never,
      response().raw as never,
      new URL('http://127.0.0.1/api/team/public'),
      { authorize: vi.fn(), validate: vi.fn(), dependencyPlan: vi.fn() },
    )).resolves.toBe(false);
  });
});
