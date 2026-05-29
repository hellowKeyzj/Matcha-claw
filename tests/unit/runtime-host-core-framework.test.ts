import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeHostContainer } from '../../runtime-host/composition/container';
import { RuntimeJobQueue, RuntimeJobRegistry } from '../../runtime-host/core/jobs';
import { RuntimeHostLifecycle } from '../../runtime-host/core/lifecycle';
import { RuntimeHostModuleRegistry, RuntimeHostRegistry } from '../../runtime-host/core/registry';
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

  it('module registry 以模块名注册并拒绝重复模块', () => {
    const registry = new RuntimeHostModuleRegistry([
      { name: 'runtime' },
    ]);

    expect(() => registry.register({ name: 'runtime' })).toThrow(
      'Runtime host registry entry already registered: runtime',
    );
    expect(registry.list()).toEqual([{ name: 'runtime' }]);
  });

  it('module registry 拒绝空模块名，避免组合根出现匿名模块', () => {
    const registry = new RuntimeHostModuleRegistry();

    expect(() => registry.register({ name: '   ' })).toThrow(
      'Runtime host module name is required',
    );
  });

  it('module registry 执行阶段失败时带出模块名和阶段名', () => {
    const registry = new RuntimeHostModuleRegistry([
      { name: 'openclaw' },
    ]);

    expect(() => registry.run('jobs', () => {
      throw new Error('boom');
    })).toThrow('Runtime host module stage failed: openclaw.jobs: boom');
  });
});
