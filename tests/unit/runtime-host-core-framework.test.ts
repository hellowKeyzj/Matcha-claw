import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeHostContainer } from '../../runtime-host/composition/container';
import { RuntimeJobQueue, RuntimeJobRegistry } from '../../runtime-host/core/jobs';
import { RuntimeHostLifecycle } from '../../runtime-host/core/lifecycle';
import { RuntimeHostModuleRegistry, RuntimeHostRegistry } from '../../runtime-host/core/registry';
import { RuntimeHostRouteRegistry } from '../../runtime-host/composition/route-registry';
import {
  listRuntimeHostApplicationModuleRegistrationDiagnostics,
  validateRuntimeHostApplicationModuleRegistrationOwners,
} from '../../runtime-host/composition/runtime-host-module-registry';
import { createTestRuntimeScheduler } from './helpers/runtime-scheduler';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const scheduler = createTestRuntimeScheduler();
const clock = {
  current: 1000,
  nowMs() {
    return this.current;
  },
  nowIso() {
    return new Date(this.current).toISOString();
  },
};

afterEach(() => {
  vi.useRealTimers();
  clock.current = 1000;
});

describe('runtime-host core framework', () => {
  it('container 只在组合根创建依赖实例', () => {
    const container = new RuntimeHostContainer();
    const factory = vi.fn(() => ({ value: 1 }));

    container.register('service', factory);

    expect(container.resolve<{ value: number }>('service')).toEqual({ value: 1 });
    expect(container.resolve<{ value: number }>('service')).toEqual({ value: 1 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('job queue 对同一个 dedupeKey 只保留一个运行中的任务', async () => {
    const registry = new RuntimeJobRegistry();
    let releaseJob = () => {};
    registry.register('plugins.refreshCatalog', async () => {
      await new Promise<void>((resolve) => {
        releaseJob = resolve;
      });
    });
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock);

    const first = queue.enqueue('plugins.refreshCatalog', null, { dedupeKey: 'plugins.refreshCatalog' });
    const second = queue.enqueue('plugins.refreshCatalog', null, { dedupeKey: 'plugins.refreshCatalog' });

    expect(second.id).toBe(first.id);
    expect(queue.latestByType('plugins.refreshCatalog')?.status).toBe('running');
    releaseJob();
    await vi.waitFor(() => {
      expect(queue.latestByType('plugins.refreshCatalog')?.status).toBe('succeeded');
    });
  });

  it('job queue 可按 id 和 type 查询任务状态快照', async () => {
    const registry = new RuntimeJobRegistry();
    registry.register('plugins.refreshCatalog', vi.fn());
    registry.register('sessions.refreshCatalog', vi.fn());
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock);

    const pluginJob = queue.enqueue('plugins.refreshCatalog', null);
    const sessionJob = queue.enqueue('sessions.refreshCatalog', null);

    await vi.waitFor(() => {
      expect(queue.get(pluginJob.id)).toMatchObject({
        id: pluginJob.id,
        type: 'plugins.refreshCatalog',
        status: 'succeeded',
      });
      expect(queue.get(sessionJob.id)).toMatchObject({
        id: sessionJob.id,
        type: 'sessions.refreshCatalog',
        status: 'succeeded',
      });
    });
    expect(queue.listByType('plugins.refreshCatalog')).toHaveLength(1);
    expect(queue.listRegisteredTypes()).toEqual([
      'plugins.refreshCatalog',
      'sessions.refreshCatalog',
    ]);
    expect(queue.snapshotQueue()).toMatchObject({
      stopped: false,
      concurrency: 2,
      totalCount: 2,
      queues: {
        critical: {
          pendingCount: 0,
        },
        default: {
          pendingCount: 0,
        },
        low: {
          pendingCount: 0,
        },
      },
    });
  });

  it('job queue 支持成功后丢弃大型结果，只保留完成状态', async () => {
    const registry = new RuntimeJobRegistry();
    registry.register('sessions.hydrateTimeline', () => ({ snapshot: { items: new Array(1000).fill({ text: 'large' }) } }));
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock);

    const job = queue.enqueue('sessions.hydrateTimeline', null, { resultRetention: 'drop' });

    await vi.waitFor(() => {
      expect(queue.get(job.id)).toMatchObject({
        status: 'succeeded',
      });
    });
    expect(queue.get(job.id)).not.toHaveProperty('result');
  });

  it('job handler 可以上报进度，队列快照会保留最新进度', async () => {
    const registry = new RuntimeJobRegistry();
    registry.register('progress.job', (_payload, context) => {
      clock.current = 1250;
      context.reportProgress({
        percent: 150,
        message: 'halfway',
      });
      clock.current = 1500;
      return { done: true };
    });
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock);

    const job = queue.enqueue('progress.job', null);

    await vi.waitFor(() => {
      expect(queue.get(job.id)).toMatchObject({
        status: 'succeeded',
        queuedAt: 1000,
        startedAt: 1000,
        finishedAt: 1500,
        progress: {
          updatedAt: 1250,
          percent: 100,
          message: 'halfway',
        },
        result: {
          done: true,
        },
      });
    });
  });

  it('job handler 可以协作式 yield 并在 checkpoint 上报进度', async () => {
    const registry = new RuntimeJobRegistry();
    const events: string[] = [];
    registry.register('yield.job', async (_payload, context) => {
      events.push('start');
      await context.checkpoint('halfway');
      events.push('after-checkpoint');
      await context.yieldIfNeeded();
      events.push('done');
      return { ok: true };
    });
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock);

    const job = queue.enqueue('yield.job', null);

    await vi.waitFor(() => {
      expect(queue.get(job.id)).toMatchObject({
        status: 'succeeded',
        progress: {
          message: 'halfway',
        },
        result: {
          ok: true,
        },
      });
    });
    expect(events).toEqual(['start', 'after-checkpoint', 'done']);
  });

  it('job queue 拒绝未注册任务类型，避免请求入口绕过注册机制', () => {
    const registry = new RuntimeJobRegistry();
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock);

    expect(() => queue.enqueue('unknown.job', null)).toThrow(
      'Runtime job handler not registered: unknown.job',
    );
  });

  it('job queue 按并发上限调度任务', async () => {
    const registry = new RuntimeJobRegistry();
    let releaseFirstJob = () => {};
    const secondHandler = vi.fn();
    registry.register('first', async () => {
      await new Promise<void>((resolve) => {
        releaseFirstJob = resolve;
      });
    });
    registry.register('second', secondHandler);
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock, { concurrency: 1 });

    const first = queue.enqueue('first', null);
    const second = queue.enqueue('second', null);

    expect(queue.list().find((job) => job.id === first.id)?.status).toBe('running');
    expect(queue.list().find((job) => job.id === second.id)?.status).toBe('queued');
    expect(secondHandler).not.toHaveBeenCalled();

    releaseFirstJob();
    await vi.waitFor(() => {
      expect(queue.list().find((job) => job.id === second.id)?.status).toBe('succeeded');
    });
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });

  it('job queue 按 critical/default/low 队列优先级调度等待任务', async () => {
    const registry = new RuntimeJobRegistry();
    let releaseFirstJob = () => {};
    const events: string[] = [];
    registry.register('first', async () => {
      events.push('first');
      await new Promise<void>((resolve) => {
        releaseFirstJob = resolve;
      });
    });
    registry.register('critical', () => {
      events.push('critical');
    });
    registry.register('low', () => {
      events.push('low');
    });
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock, { concurrency: 1 });

    queue.enqueue('first', null);
    queue.enqueue('low', null, { queue: 'low' });
    queue.enqueue('critical', null, { queue: 'critical' });

    expect(queue.snapshotQueue()).toMatchObject({
      pendingCount: 2,
      queues: {
        critical: {
          pendingCount: 1,
        },
        default: {
          pendingCount: 0,
        },
        low: {
          pendingCount: 1,
        },
      },
    });

    releaseFirstJob();
    await vi.waitFor(() => {
      expect(events).toEqual(['first', 'critical', 'low']);
    });
  });

  it('job snapshot 保留任务所属队列', async () => {
    const registry = new RuntimeJobRegistry();
    registry.register('critical', vi.fn());
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock);

    const job = queue.enqueue('critical', null, { queue: 'critical' });

    expect(job.queue).toBe('critical');
    await vi.waitFor(() => {
      expect(queue.get(job.id)).toMatchObject({
        queue: 'critical',
        status: 'succeeded',
      });
    });
  });

  it('job queue 失败后按 maxAttempts 重试并保留 dedupeKey', async () => {
    vi.useFakeTimers();
    const registry = new RuntimeJobRegistry();
    let attempts = 0;
    registry.register('retry.once', () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('first failure');
      }
    });
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock, {
      maxAttempts: 2,
      retryDelayMs: 50,
    });

    const first = queue.enqueue('retry.once', null, { dedupeKey: 'retry.once' });
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.latestByType('retry.once')?.status).toBe('queued');

    const duplicated = queue.enqueue('retry.once', null, { dedupeKey: 'retry.once' });
    expect(duplicated.id).toBe(first.id);

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    expect(queue.latestByType('retry.once')?.status).toBe('succeeded');
    expect(queue.latestByType('retry.once')).toMatchObject({
      attempts: 2,
      maxAttempts: 2,
    });
    vi.useRealTimers();
  });

  it('job queue 到达 maxAttempts 后失败并释放 dedupeKey', async () => {
    vi.useFakeTimers();
    const registry = new RuntimeJobRegistry();
    registry.register('retry.fail', () => {
      throw new Error('always fails');
    });
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock, {
      maxAttempts: 2,
      retryDelayMs: 50,
    });

    const first = queue.enqueue('retry.fail', null, { dedupeKey: 'retry.fail' });
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.latestByType('retry.fail')?.status).toBe('queued');
    expect(queue.enqueue('retry.fail', null, { dedupeKey: 'retry.fail' }).id).toBe(first.id);

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    expect(queue.latestByType('retry.fail')?.status).toBe('failed');

    const next = queue.enqueue('retry.fail', null, { dedupeKey: 'retry.fail' });
    expect(next.id).not.toBe(first.id);
    vi.useRealTimers();
  });

  it('job queue stop 会失败未开始任务并拒绝继续入队', async () => {
    const registry = new RuntimeJobRegistry();
    let releaseFirstJob = () => {};
    registry.register('first', async () => {
      await new Promise<void>((resolve) => {
        releaseFirstJob = resolve;
      });
    });
    registry.register('second', vi.fn());
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock, { concurrency: 1 });

    queue.enqueue('first', null);
    const second = queue.enqueue('second', null);
    const stopPromise = queue.stop();

    expect(queue.list().find((job) => job.id === second.id)).toMatchObject({
      status: 'failed',
      error: 'Runtime job queue stopped',
    });
    expect(() => queue.enqueue('second', null)).toThrow('Runtime job queue is stopped');

    releaseFirstJob();
    await stopPromise;
    expect(queue.latestByType('first')?.status).toBe('succeeded');
  });

  it('job queue 已完成任务在 retention 到期后从内存中驱逐', async () => {
    vi.useFakeTimers();
    const registry = new RuntimeJobRegistry();
    registry.register('one-shot', vi.fn(() => 'done'));
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock, {
      retentionSucceededMs: 100,
      retentionFailedMs: 100,
    });

    const job = queue.enqueue('one-shot', null);
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.get(job.id)?.status).toBe('succeeded');

    await vi.advanceTimersByTimeAsync(100);
    expect(queue.get(job.id)).toBeNull();
    expect(queue.list()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('job queue 已完成任务超过 maxRetainedJobs 时按 finishedAt 升序裁剪', async () => {
    const registry = new RuntimeJobRegistry();
    registry.register('one-shot', vi.fn());
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock, {
      retentionSucceededMs: 60_000,
      maxRetainedJobs: 2,
    });

    clock.current = 2000;
    const a = queue.enqueue('one-shot', null);
    await vi.waitFor(() => expect(queue.get(a.id)?.status).toBe('succeeded'));
    clock.current = 2500;
    const b = queue.enqueue('one-shot', null);
    await vi.waitFor(() => expect(queue.get(b.id)?.status).toBe('succeeded'));
    clock.current = 3000;
    const c = queue.enqueue('one-shot', null);
    await vi.waitFor(() => expect(queue.get(c.id)?.status).toBe('succeeded'));

    expect(queue.get(a.id)).toBeNull();
    expect(queue.get(b.id)?.status).toBe('succeeded');
    expect(queue.get(c.id)?.status).toBe('succeeded');
  });

  it('job queue dedupeCooldownMs 命中冷却时返回最近完成任务，不入新队', async () => {
    vi.useFakeTimers();
    const handler = vi.fn(() => 'ok');
    const registry = new RuntimeJobRegistry();
    registry.register('refresh.snapshot', handler);
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock, {
      retentionSucceededMs: 60_000,
    });

    clock.current = 5000;
    const first = queue.enqueue('refresh.snapshot', null, {
      dedupeKey: 'refresh.snapshot',
      dedupeCooldownMs: 1000,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.get(first.id)?.status).toBe('succeeded');

    clock.current = 5500;
    const cooled = queue.enqueue('refresh.snapshot', null, {
      dedupeKey: 'refresh.snapshot',
      dedupeCooldownMs: 1000,
    });
    expect(cooled.id).toBe(first.id);
    expect(handler).toHaveBeenCalledTimes(1);

    clock.current = 6500;
    const refreshed = queue.enqueue('refresh.snapshot', null, {
      dedupeKey: 'refresh.snapshot',
      dedupeCooldownMs: 1000,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshed.id).not.toBe(first.id);
    expect(handler).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('job queue eviction 会清掉 pending 队列里的 stale id', async () => {
    const registry = new RuntimeJobRegistry();
    registry.register('queued.cleanup', vi.fn(async () => undefined));
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock, {
      concurrency: 1,
      retentionSucceededMs: 60_000,
    });
    const job = queue.enqueue('queued.cleanup', null, { queue: 'low' });
    (queue as unknown as { evictJob: (jobId: string) => void }).evictJob(job.id);

    expect(queue.get(job.id)).toBeNull();
    expect(queue.snapshotQueue().pendingCount).toBe(0);
    expect(queue.snapshotQueue().queues.low.pendingCount).toBe(0);
  });

  it('job queue finish 时清掉 payload 引用以释放大对象', async () => {
    const largePayload = { blob: new Array(1024).fill('x').join('') };
    const registry = new RuntimeJobRegistry();
    registry.register('large.payload', vi.fn());
    const queue = new RuntimeJobQueue(registry, logger, scheduler, clock, {
      retentionSucceededMs: 60_000,
    });

    const job = queue.enqueue('large.payload', largePayload);
    await vi.waitFor(() => expect(queue.get(job.id)?.status).toBe('succeeded'));

    // 通过 latestByType 拿到 record（snapshot 不含 payload，但内存层应已释放引用）
    // 这里通过反射式读取保证内部状态被清理
    const record = (queue as unknown as { jobs: Map<string, { payload: unknown }> }).jobs.get(job.id);
    expect(record?.payload).toBeNull();
  });

  it('lifecycle 统一启动后台服务并按逆序清理', async () => {
    const lifecycle = new RuntimeHostLifecycle(logger);
    const events: string[] = [];
    lifecycle.registerBackgroundService({
      name: 'one',
      start: () => events.push('start:one'),
      stop: () => events.push('stop:one'),
    });
    lifecycle.registerBackgroundService({
      name: 'two',
      start: () => events.push('start:two'),
      stop: () => events.push('stop:two'),
    });
    lifecycle.registerCleanup({
      name: 'cleanup',
      run: () => events.push('cleanup'),
    });

    lifecycle.markRunning();
    lifecycle.startBackgroundServices();
    await vi.waitFor(() => {
      expect(events).toEqual(['start:one', 'start:two']);
    });
    await lifecycle.stop();

    expect(lifecycle.getState()).toBe('stopped');
    expect(events).toEqual(['start:one', 'start:two', 'stop:two', 'stop:one', 'cleanup']);
  });

  it('lifecycle 拒绝重复后台服务名且不会重复启动同一服务', async () => {
    const lifecycle = new RuntimeHostLifecycle(logger);
    const service = {
      name: 'jobs.worker',
      start: vi.fn(),
      stop: vi.fn(),
    };
    lifecycle.registerBackgroundService(service);

    expect(() => lifecycle.registerBackgroundService({
      name: 'jobs.worker',
      start: vi.fn(),
    })).toThrow('Runtime host background service already registered: jobs.worker');

    lifecycle.markRunning();
    lifecycle.startBackgroundServices();
    lifecycle.startBackgroundServices();
    await vi.waitFor(() => {
      expect(service.start).toHaveBeenCalledTimes(1);
    });

    await lifecycle.stop();
    expect(service.stop).toHaveBeenCalledTimes(1);
  });

  it('lifecycle 拒绝重复清理任务名', () => {
    const lifecycle = new RuntimeHostLifecycle(logger);
    lifecycle.registerCleanup({
      name: 'resource',
      run: vi.fn(),
    });

    expect(() => lifecycle.registerCleanup({
      name: 'resource',
      run: vi.fn(),
    })).toThrow('Runtime host cleanup task already registered: resource');
  });

  it('registry 显式拒绝重复能力 key', () => {
    const registry = new RuntimeHostRegistry<string, () => void>();

    registry.register('capability.one', vi.fn());

    expect(() => registry.register('capability.one', vi.fn())).toThrow(
      'Runtime host registry entry already registered: capability.one',
    );
    expect(registry.list()).toHaveLength(1);
  });

  it('container 记录 factory resolve 的跨 owner 依赖边', () => {
    const container = new RuntimeHostContainer();

    container.withRegistrationOwner('infrastructure', () => {
      container.registerValue('runtime.clock', { nowMs: () => 1 });
    });
    container.withRegistrationOwner('sessions', () => {
      container.register('session.service', (scope) => ({
        clock: scope.resolve('runtime.clock'),
      }));
      container.register('session.facade', (scope) => scope.resolve('session.service'));
    });

    container.resolve('session.facade');

    expect(container.listResolveEdges()).toEqual([
      {
        fromOwner: 'sessions',
        toOwner: 'infrastructure',
        key: 'runtime.clock',
      },
    ]);
  });

  it('container 记录同一 contribution token 的多个 contributor owner', () => {
    const container = new RuntimeHostContainer();

    container.withRegistrationOwner('sessions', () => {
      container.contribute('agentRuntime.capabilityOperationRoutes', () => ['session.prompt']);
    });
    container.withRegistrationOwner('operations', () => {
      container.contribute('agentRuntime.capabilityOperationRoutes', () => ['tool.invoke']);
    });

    expect(container.listRegistrations()).toEqual([
      {
        key: 'agentRuntime.capabilityOperationRoutes',
        owner: 'sessions',
        kind: 'contribution',
        resolved: false,
      },
      {
        key: 'agentRuntime.capabilityOperationRoutes',
        owner: 'operations',
        kind: 'contribution',
        resolved: false,
      },
    ]);
  });

  it('container 执行 contribution factory 时使用 contributor owner 记录依赖边', () => {
    const container = new RuntimeHostContainer();

    container.withRegistrationOwner('sessions', () => {
      container.registerValue('sessionCommandService', { ok: true });
      container.contribute('agentRuntime.capabilityOperationRoutes', (scope) => [scope.resolve('sessionCommandService')]);
    });
    container.withRegistrationOwner('agent-runtime', () => {
      container.register('agentRuntime.capabilityRouter', (scope) => scope.resolveContributions('agentRuntime.capabilityOperationRoutes'));
    });

    container.resolve('agentRuntime.capabilityRouter');

    expect(container.listResolveEdges()).toEqual([
      {
        fromOwner: 'agent-runtime',
        toOwner: 'sessions',
        key: 'agentRuntime.capabilityOperationRoutes',
      },
    ]);
  });

  it('module registry 以模块名注册并拒绝重复模块', () => {
    const registry = new RuntimeHostModuleRegistry([
      { name: 'runtime', manifest: { id: 'runtime' } },
    ]);

    expect(() => registry.register({ name: 'runtime', manifest: { id: 'runtime' } })).toThrow(
      'Runtime host registry entry already registered: runtime',
    );
    expect(registry.list()).toEqual([{ name: 'runtime', manifest: { id: 'runtime' } }]);
  });

  it('module registry 拒绝空模块名，避免组合根出现匿名模块', () => {
    const registry = new RuntimeHostModuleRegistry();

    expect(() => registry.register({ name: '   ', manifest: { id: '   ' } })).toThrow(
      'Runtime host module name is required',
    );
  });

  it('module registry 要求所有模块显式声明 manifest', () => {
    expect(() => new RuntimeHostModuleRegistry([
      { name: 'runtime', manifest: undefined as never },
    ])).toThrow('Runtime host module manifest is required: runtime');
  });

  it('module registry 校验 manifest id、重复 export 和缺失 import', () => {
    expect(() => new RuntimeHostModuleRegistry([
      { name: 'runtime', manifest: { id: 'sessions' } },
    ])).toThrow('Runtime host module manifest id mismatch: runtime != sessions');

    expect(() => new RuntimeHostModuleRegistry([
      { name: 'runtime', manifest: { id: 'runtime', exports: ['gateway.runtime'] } },
      { name: 'gateway', manifest: { id: 'gateway', exports: ['gateway.runtime'] } },
    ])).toThrow('Runtime host module export already registered: gateway.runtime by runtime and gateway');

    expect(() => new RuntimeHostModuleRegistry([
      { name: 'sessions', manifest: { id: 'sessions', imports: ['gateway.runtime'] } },
    ])).toThrow('Runtime host module import not exported: sessions imports gateway.runtime');
  });

  it('module registry 允许 manifest import 使用 external export', () => {
    const registry = new RuntimeHostModuleRegistry([
      { name: 'sessions', manifest: { id: 'sessions', imports: ['gateway.runtime'], exports: ['session.runtime'] } },
    ], {
      externalExports: ['gateway.runtime'],
    });

    expect(registry.listImports()).toEqual([{ moduleName: 'sessions', token: 'gateway.runtime' }]);
    expect(registry.listExports()).toEqual([{ moduleName: 'sessions', token: 'session.runtime' }]);
  });

  it('module registry 拒绝 import/export 模块环', () => {
    expect(() => new RuntimeHostModuleRegistry([
      { name: 'gateway', manifest: { id: 'gateway', imports: ['agentRuntime.registry'], exports: ['gateway.runtime'] } },
      { name: 'agent-runtime', manifest: { id: 'agent-runtime', imports: ['gateway.runtime'], exports: ['agentRuntime.registry'] } },
    ])).toThrow('Runtime host module import cycle: gateway -> agent-runtime -> gateway');
  });

  it('module registry 拒绝 connect import 缺失和 connect 顺序环', () => {
    expect(() => new RuntimeHostModuleRegistry([
      { name: 'session-runtime', manifest: { id: 'session-runtime', connect: true, connectImports: ['gateway-bridge'] } },
    ])).toThrow('Runtime host module connect import not registered: session-runtime imports gateway-bridge');

    expect(() => new RuntimeHostModuleRegistry([
      { name: 'gateway-bridge', manifest: { id: 'gateway-bridge', connect: true, connectImports: ['session-runtime'] } },
      { name: 'session-runtime', manifest: { id: 'session-runtime', connect: true, connectImports: ['gateway-bridge'] } },
    ])).toThrow('Runtime host module connect cycle: gateway-bridge -> session-runtime -> gateway-bridge');
  });

  it('module registry 拒绝未声明 import 的跨 owner resolve', () => {
    const registry = new RuntimeHostModuleRegistry([
      { name: 'gateway', manifest: { id: 'gateway', exports: ['gateway.runtime'] } },
      { name: 'storage', manifest: { id: 'storage', exports: ['session.storage'] } },
      { name: 'sessions', manifest: { id: 'sessions', imports: ['session.storage'], exports: ['session.runtime'] } },
    ]);

    expect(() => registry.validateResolveImports([
      { fromOwner: 'sessions', toOwner: 'gateway', key: 'gateway.runtime' },
    ])).toThrow('Runtime host module import not declared: sessions resolves gateway.runtime');
  });

  it('module registry 拒绝跨 owner resolve 未导出的内部 token', () => {
    const registry = new RuntimeHostModuleRegistry([
      { name: 'gateway', manifest: { id: 'gateway', exports: ['gateway.runtime'] } },
      { name: 'sessions', manifest: { id: 'sessions', imports: ['gateway.client'], exports: ['session.runtime'] } },
    ], {
      externalExports: ['gateway.client'],
    });

    expect(() => registry.validateResolveImports([
      { fromOwner: 'sessions', toOwner: 'gateway', key: 'gateway.client' },
    ])).toThrow('Runtime host module dependency not exported: sessions resolves gateway.client owned by gateway');
  });

  it('module registry 允许已声明 import 的跨 owner resolve', () => {
    const registry = new RuntimeHostModuleRegistry([
      { name: 'gateway', manifest: { id: 'gateway', exports: ['gateway.runtime'] } },
      { name: 'sessions', manifest: { id: 'sessions', imports: ['gateway.runtime'], exports: ['session.runtime'] } },
    ]);

    expect(() => registry.validateResolveImports([
      { fromOwner: 'sessions', toOwner: 'gateway', key: 'gateway.runtime' },
    ])).not.toThrow();
  });

  it('module registry 拒绝未声明 import 的 external export resolve', () => {
    const registry = new RuntimeHostModuleRegistry([
      { name: 'sessions', manifest: { id: 'sessions', exports: ['session.runtime'] } },
    ], {
      externalExports: ['gateway.runtime'],
    });

    expect(() => registry.validateResolveImports([
      { fromOwner: 'sessions', toOwner: null, key: 'gateway.runtime' },
    ])).toThrow('Runtime host module import not declared: sessions resolves gateway.runtime');
  });

  it('module registry 允许已声明 import 的 external export resolve', () => {
    const registry = new RuntimeHostModuleRegistry([
      { name: 'sessions', manifest: { id: 'sessions', imports: ['gateway.runtime'], exports: ['session.runtime'] } },
    ], {
      externalExports: ['gateway.runtime'],
    });

    expect(() => registry.validateResolveImports([
      { fromOwner: 'sessions', toOwner: null, key: 'gateway.runtime' },
    ])).not.toThrow();
  });

  it('module registry 用显式 manifest 阶段字段约束可执行阶段', () => {
    interface TestModule {
      readonly name: string;
      readonly manifest: {
        readonly id: string;
        readonly registerProviders?: boolean;
        readonly registerJobs?: boolean;
        readonly connect?: boolean;
      };
      readonly registerServices?: () => void;
      readonly registerJobs?: () => void;
      readonly connect?: () => void;
    }
    const services = vi.fn();
    const jobs = vi.fn();
    const connect = vi.fn();
    const registry = new RuntimeHostModuleRegistry<TestModule>([
      { name: 'runtime', manifest: { id: 'runtime', registerProviders: true }, registerServices: services },
      { name: 'jobs', manifest: { id: 'jobs', registerJobs: true }, registerJobs: jobs },
      { name: 'connector', manifest: { id: 'connector', connect: true }, connect },
    ], {
      stages: [
        { name: 'services', handler: 'registerServices' },
        { name: 'jobs', handler: 'registerJobs' },
        { name: 'connect', handler: 'connect' },
      ],
    });

    registry.run('services', (module) => module.registerServices?.());
    registry.run('connect', (module) => module.connect?.());

    expect(services).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(jobs).not.toHaveBeenCalled();
  });

  it('module registry 拒绝显式阶段字段和 handler 不一致的模块', () => {
    interface TestModule {
      readonly name: string;
      readonly manifest: {
        readonly id: string;
        readonly registerProviders?: boolean;
      };
      readonly registerServices?: () => void;
    }

    expect(() => new RuntimeHostModuleRegistry<TestModule>([
      { name: 'runtime', manifest: { id: 'runtime', registerProviders: true } },
    ], {
      stages: [{ name: 'services', handler: 'registerServices' }],
    })).toThrow('Runtime host module stage handler missing: runtime.services');

    expect(() => new RuntimeHostModuleRegistry<TestModule>([
      { name: 'runtime', manifest: { id: 'runtime' }, registerServices: vi.fn() },
    ], {
      stages: [{ name: 'services', handler: 'registerServices' }],
    })).toThrow('Runtime host module stage not declared: runtime.services');
  });

  it('route registry dispatcher uses exact path index before prefix and pattern buckets', async () => {
    const routes = new RuntimeHostRouteRegistry();
    const exact = vi.fn(() => ({ status: 200, data: { route: 'exact' } }));
    const prefix = vi.fn(() => ({ status: 200, data: { route: 'prefix' } }));
    const pattern = vi.fn(() => ({ status: 200, data: { route: 'pattern' } }));

    routes.registerDefinitions('sessions', [
      { method: 'POST', path: '/api/sessions/prompt', handle: exact },
      { method: 'POST', prefix: '/api/sessions/', handle: prefix },
      { method: 'POST', pattern: /^\/api\/sessions\//, handle: pattern },
    ], {});

    await expect(routes.dispatcher()('POST', '/api/sessions/prompt?ignored=1', {})).resolves.toEqual({
      status: 200,
      data: { route: 'exact' },
    });
    expect(exact).toHaveBeenCalledTimes(1);
    expect(prefix).not.toHaveBeenCalled();
    expect(pattern).not.toHaveBeenCalled();
  });

  it('application module diagnostics 合并 route/job/lifecycle 注册 owner', () => {
    const container = new RuntimeHostContainer();
    const jobRegistry = new RuntimeJobRegistry();
    const lifecycle = new RuntimeHostLifecycle(logger);
    const routes = new RuntimeHostRouteRegistry();

    container.withRegistrationOwner('openclaw', () => {
      container.registerValue('settings.service', { ok: true });
    });
    jobRegistry.withRegistrationOwner('runtime', () => {
      jobRegistry.register('diagnostics.collect', () => undefined);
    });
    lifecycle.withRegistrationOwner('operations', () => {
      lifecycle.registerBackgroundService({ name: 'cron.jobs-refresh', start: () => undefined });
    });
    routes.withRegistrationOwner('sessions', () => {
      routes.registerDefinitions('sessions', [
        {
          method: 'POST',
          path: '/api/capabilities/execute',
          handle: () => ({ status: 200, data: { success: true } }),
        },
      ], {});
    });

    expect(listRuntimeHostApplicationModuleRegistrationDiagnostics(container, {
      jobRegistry,
      lifecycle,
      routes,
    })).toEqual(expect.arrayContaining([
      { key: 'settings.service', owner: 'openclaw', exported: true },
      { key: 'diagnostics.collect', owner: 'runtime', exported: false },
      { key: 'cron.jobs-refresh', owner: 'operations', exported: false },
      { key: 'sessions.POST /api/capabilities/execute', owner: 'sessions', exported: false },
    ]));
  });

  it('module registry 允许模块注册未导出的内部 token', () => {
    const container = new RuntimeHostContainer();

    container.withRegistrationOwner('openclaw', () => {
      container.registerValue('openclaw.internalOnly', { ok: true });
    });

    expect(() => validateRuntimeHostApplicationModuleRegistrationOwners(container)).not.toThrow();
  });

  it('application module owner 校验覆盖 job/lifecycle registry 注册项', () => {
    const container = new RuntimeHostContainer();
    const jobRegistry = new RuntimeJobRegistry();
    const lifecycle = new RuntimeHostLifecycle(logger);

    jobRegistry.withRegistrationOwner('runtime', () => {
      jobRegistry.register('settings.service', () => undefined);
    });
    expect(() => validateRuntimeHostApplicationModuleRegistrationOwners(container, {
      jobRegistry,
    })).toThrow('Runtime host module export owner mismatch: settings.service exported by openclaw but registered by runtime');

    lifecycle.withRegistrationOwner('runtime', () => {
      lifecycle.registerBackgroundService({ name: 'cron.service', start: () => undefined });
    });
    expect(() => validateRuntimeHostApplicationModuleRegistrationOwners(container, {
      lifecycle,
    })).toThrow('Runtime host module export owner mismatch: cron.service exported by operations but registered by runtime');
  });

  it('module registry 执行阶段失败时带出模块名和阶段名', () => {
    const registry = new RuntimeHostModuleRegistry([
      { name: 'openclaw', manifest: { id: 'openclaw', registerJobs: true }, registerJobs: () => undefined },
    ], {
      stages: [{ name: 'jobs', handler: 'registerJobs' }],
    });

    expect(() => registry.run('jobs', () => {
      throw new Error('boom');
    })).toThrow('Runtime host module stage failed: openclaw.jobs: boom');
  });
});
