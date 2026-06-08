import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamRunService } from '../../packages/openclaw-team-runtime-plugin/src/application/team-run-service';
import { TeamSkillPackageService } from '../../packages/openclaw-team-runtime-plugin/src/application/team-skill-package-service';
import type { TaskFlowProjectionPort } from '../../packages/openclaw-team-runtime-plugin/src/ports/task-flow-projection-port';
import type { TaskManagerProjectionPort } from '../../packages/openclaw-team-runtime-plugin/src/ports/task-manager-projection-port';

const fixturePath = path.resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0');

function createService(storageRoot: string, taskManagerProjection?: TaskManagerProjectionPort, taskFlowProjection?: TaskFlowProjectionPort) {
  let now = 1;
  return new TeamRunService({
    storageRoot,
    clock: { nowMs: () => now++ },
    idGenerator: { randomId: () => `id-${now++}` },
    packageService: new TeamSkillPackageService(),
    ...(taskManagerProjection ? { taskManagerProjection } : {}),
    ...(taskFlowProjection ? { taskFlowProjection } : {}),
  });
}

describe('TeamRunService task-manager projection', () => {
  let storageRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'team-runtime-projection-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('records successful projection events when projection port is configured', async () => {
    const projectTeamRun = vi.fn().mockResolvedValue(undefined);
    const service = createService(storageRoot, { projectTeamRun });

    await service.create({ packagePath: fixturePath, runId: 'run-project-success', idempotencyKey: 'create-project-success' });
    await service.start({ runId: 'run-project-success', idempotencyKey: 'start-project-success' });

    const snapshot = await service.snapshot({ runId: 'run-project-success', eventCursor: 0 });
    expect(projectTeamRun).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({ runId: 'run-project-success', status: 'running' }),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-0-pre-flight-dependency-check', status: 'running' }),
      ]),
      reason: 'run:started',
    }));
    expect(snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'projection:taskManager:queued', payload: { reason: 'run:started' } }),
    ]));
  });

  it('projects Task Flow and Task Manager independently', async () => {
    const projectTaskManager = vi.fn().mockResolvedValue(undefined);
    const projectTaskFlow = vi.fn().mockRejectedValue(new Error('task flow offline'));
    const service = createService(storageRoot, { projectTeamRun: projectTaskManager }, { projectTeamRun: projectTaskFlow, projectTaskUpdate: vi.fn() });

    await service.create({ packagePath: fixturePath, runId: 'run-project-independent', idempotencyKey: 'create-project-independent' });
    await expect(service.start({ runId: 'run-project-independent', idempotencyKey: 'start-project-independent' })).resolves.toEqual(expect.objectContaining({
      runId: 'run-project-independent',
      status: 'running',
    }));

    const snapshot = await service.snapshot({ runId: 'run-project-independent', eventCursor: 0 });
    expect(projectTaskFlow).toHaveBeenCalled();
    expect(projectTaskManager).toHaveBeenCalled();
    expect(snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'projection:taskFlow:failed',
        payload: { reason: 'run:started', error: 'task flow offline' },
      }),
      expect.objectContaining({ type: 'projection:taskManager:queued', payload: { reason: 'run:started' } }),
    ]));
  });

  it('records projection failure without failing TeamRun transitions', async () => {
    const service = createService(storageRoot, {
      projectTeamRun: vi.fn().mockRejectedValue(new Error('projection offline')),
    });

    await service.create({ packagePath: fixturePath, runId: 'run-project-fail', idempotencyKey: 'create-project-fail' });
    await expect(service.start({ runId: 'run-project-fail', idempotencyKey: 'start-project-fail' })).resolves.toEqual(expect.objectContaining({
      runId: 'run-project-fail',
      status: 'running',
    }));

    const snapshot = await service.snapshot({ runId: 'run-project-fail', eventCursor: 0 });
    expect(snapshot.run).toEqual(expect.objectContaining({ status: 'running' }));
    expect(snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'projection:taskManager:failed',
        payload: { reason: 'run:started', error: 'projection offline' },
      }),
    ]));
  });
});
