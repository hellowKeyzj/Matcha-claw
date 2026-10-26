import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { UseElectron } from './use-electron.ability.js';

const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } as const;
const scope = { kind: 'runtime-instance', endpoint } as const;
const jobsPath = `/api/cron/jobs?scope=${encodeURIComponent(JSON.stringify(scope))}`;
const privateFields = /(?:authorization|bearer|token|secret|apiKey|password|configDir|workspaceDir|sessionKey|sourcePath)/i;
const privateCanary = 'cron-e2e-private-canary';
type ScheduledJob = { id: string; name: string; message: string; enabled: boolean; schedule: { kind: string; at?: string; expr?: string }; delivery?: { mode: string }; lastRun?: { time: string; success: boolean }; runningAt?: string };
type TriggerCall = { callId: string; module: string; command: string; status: string; revision: number; detail: { jobId?: string; runId?: string; outcome?: string; executionStatus?: string } };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class ScheduledTasks extends Ability {
  private initialName = '';
  private updatedName = '';
  private message = '';
  private updatedMessage = '';
  private initialAt = '';
  private updatedAt = '';
  private mode: 'manage' | 'trigger' = 'manage';
  private originalJobIds = new Set<string>();
  private jobId?: string;
  private pending?: 'create' | 'update' | 'toggle' | 'delete';
  private execution: { state: 'not-submitted' } | { state: 'unsettled'; callId?: string; runId?: string }
    | { state: 'settled'; callId: string; runId: string } = { state: 'not-submitted' };

  constructor(private readonly electron: UseElectron) { super(); }

  async prepare(mode: 'manage' | 'trigger') {
    if (this.pending || this.jobId || this.execution.state === 'unsettled') throw new Error('Previous scheduled-task ownership is unresolved; do not discard it');
    const schedules = await this.electron.page.evaluate(() => {
      const initial = new Date();
      initial.setFullYear(initial.getFullYear() + 2);
      initial.setHours(12, 0, 0, 0);
      const updated = new Date(initial);
      updated.setDate(updated.getDate() + 1);
      updated.setHours(updated.getHours() + 1);
      const pad = (value: number) => String(value).padStart(2, '0');
      const schedule = (value: Date) => ({
        date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
        time: `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`,
        at: value.toISOString(),
      });
      return { initialSchedule: schedule(initial), updatedSchedule: schedule(updated) };
    });
    this.initialAt = schedules.initialSchedule.at;
    this.updatedAt = schedules.updatedSchedule.at;
    this.mode = mode;
    this.initialName = `E2E scheduled task ${randomUUID()}`;
    this.updatedName = `${this.initialName} updated`;
    this.message = mode === 'trigger' ? 'Reply only OK. Do not use tools.' : 'E2E scheduled task placeholder. Do not run.';
    this.updatedMessage = mode === 'trigger' ? this.message : `${this.message} Updated.`;
    this.originalJobIds = new Set();
    this.execution = { state: 'not-submitted' };
    return { initialName: this.initialName, updatedName: this.updatedName, message: this.message, updatedMessage: this.updatedMessage, ...schedules };
  }

  async rememberBaseline(): Promise<void> {
    const jobs = await this.waitForSnapshot(() => true);
    if (jobs.some(job => job.name === this.initialName || job.name === this.updatedName)) throw new Error('Scheduled-task UUID is not independent');
    this.originalJobIds = new Set(jobs.map(job => job.id));
  }

  markSubmission(operation: 'create' | 'update' | 'toggle' | 'delete'): void {
    if (this.pending || (operation === 'create' ? this.jobId !== undefined : !this.jobId)) throw new Error('Refusing a duplicate or unowned Cron mutation');
    if (operation === 'delete' && this.execution.state === 'unsettled') throw new Error('Deleting a job is not execution cancellation');
    this.pending = operation;
  }

  async observeCreated() {
    const jobs = await this.waitForSnapshot(jobs => jobs.filter(job => job.name === this.initialName).length === 1);
    const job = jobs.find(job => job.name === this.initialName)!;
    if (this.originalJobIds.has(job.id) || job.message !== this.message) throw new Error('Cron creation did not produce this exact UUID-owned job');
    this.jobId = job.id;
    this.pending = undefined;
    this.assertJob(job, false, true);
    return { id: job.id, selector: `[data-testid="cron-job-card-${job.id}"]` };
  }

  async observeJob(updated: boolean, enabled: boolean): Promise<boolean> {
    const jobs = await this.waitForSnapshot(jobs => jobs.some(job => job.id === this.jobId
      && job.name === (updated ? this.updatedName : this.initialName) && job.message === (updated ? this.updatedMessage : this.message)
      && job.enabled === enabled));
    this.assertJob(jobs.find(job => job.id === this.jobId)!, updated, enabled);
    this.pending = undefined;
    return true;
  }

  private assertJob(job: ScheduledJob, updated: boolean, enabled: boolean): void {
    const scheduleMatches = updated && this.mode === 'trigger'
      ? job.schedule.kind === 'cron' && job.schedule.expr === '0 0 29 2 *'
      : job.schedule.kind === 'at' && job.schedule.at === (updated ? this.updatedAt : this.initialAt);
    if (job.id !== this.jobId || job.name !== (updated ? this.updatedName : this.initialName)
      || job.message !== (updated ? this.updatedMessage : this.message) || job.enabled !== enabled
      || job.delivery?.mode !== 'none' || !scheduleMatches) throw new Error('Cron public readback disagrees with the UI-submitted job');
  }

  async confirmDeleted(): Promise<boolean> {
    const id = this.jobId;
    if (!id) throw new Error('No exact scheduled-task identity to confirm');
    await this.waitForSnapshot(jobs => !jobs.some(job => job.id === id));
    this.jobId = undefined;
    this.pending = undefined;
    return true;
  }

  async cleanupTarget() {
    if (this.execution.state === 'unsettled') await this.reconcileExecution();
    if (this.pending === 'delete') { await this.confirmDeleted(); return false; }
    if (this.pending) throw new Error(`Cron ${this.pending} outcome is unresolved; preserve ownership, never replay or blindly delete`);
    if (!this.jobId) return false;
    const job = (await this.waitForSnapshot(() => true)).find(job => job.id === this.jobId);
    if (!job) { this.jobId = undefined; return false; }
    if (this.originalJobIds.has(job.id) || ![this.initialName, this.updatedName].includes(job.name)
      || ![this.message, this.updatedMessage].includes(job.message)) throw new Error('Refusing cleanup: exact Cron ID no longer belongs to this case UUID');
    return { id: job.id, selector: `[data-testid="cron-job-card-${job.id}"]` };
  }

  async rejectMalformedTrigger() {
    const jobId = `invalid-${randomUUID()}`;
    const reply = await this.electron.fetchHostApi({
      method: 'POST', path: '/api/capabilities/execute',
      body: { id: 'scheduler.cron', operationId: 'cron.trigger', scope, target: { kind: 'cron-job', jobId }, input: { id: jobId, privateCanary } },
    });
    const body = record(reply.ok ? reply.data.json : undefined);
    const serialized = JSON.stringify(reply);
    return {
      transportOk: reply.ok, status: reply.ok ? reply.data.status : null, httpOk: reply.ok ? reply.data.ok : null,
      fixedRejection: body.success === false && body.error === 'Cron trigger request is invalid' && Object.keys(body).length === 2,
      privateInputReflected: serialized.includes(privateCanary), privateFieldExposed: privateFields.test(serialized),
    };
  }

  async requirePublicExecutionPrerequisites(): Promise<void> {
    const gateway = await this.electron.fetchHostApi({ method: 'GET', path: '/api/gateway/status' });
    const state = record(gateway.ok ? gateway.data.json : undefined);
    if (!gateway.ok || gateway.data.status !== 200 || !gateway.data.ok || state.processState !== 'running'
      || state.gatewayReady !== true || state.transportState !== 'connected') throw new Error('Real Cron execution requires a ready public OpenClaw gateway');
    const models = await this.electron.fetchHostApi({ method: 'GET', path: '/api/provider-models/selectable?capability=chat' });
    const catalog = record(models.ok ? models.data.json : undefined);
    if (!models.ok || models.data.status !== 200 || !models.data.ok || !Array.isArray(catalog.models)
      || !catalog.models.some(value => {
        const model = record(value);
        return typeof model.selectionId === 'string' && typeof model.modelId === 'string'
          && Array.isArray(model.modelReferences) && model.modelReferences.length > 0;
      })) throw new Error('Real Cron execution requires a configured public chat model; no model or credentials are injected');
  }

  async armTrigger(): Promise<void> {
    if (!this.jobId || this.pending || this.execution.state !== 'not-submitted') throw new Error('Refusing an unowned or duplicate Cron trigger');
    if ((await this.readTriggerCalls(this.jobId)).length !== 0) throw new Error('Owned job already has a trigger call; refusing duplicate execution');
    await this.waitForSnapshot(jobs => jobs.some(job => job.id === this.jobId && !job.enabled && !job.lastRun && !job.runningAt));
    this.execution = { state: 'unsettled' };
  }

  async observeNativeCompletion() {
    if (!this.jobId || this.execution.state !== 'unsettled') throw new Error('No single armed Cron execution');
    const jobId = this.jobId;
    const deadline = Date.now() + 120_000;
    let callId: string | undefined;
    let runId: string | undefined;
    let revision = 0;
    while (Date.now() < deadline) {
      let call: TriggerCall | undefined;
      if (!callId) {
        const calls = await this.readTriggerCalls(jobId);
        if (calls.length > 1) throw new Error('More than one trigger call exists for the UUID-owned job');
        call = calls[0];
        callId = call?.callId;
      } else call = await this.readCall(callId);
      if (call) {
        const detail = record(call.detail);
        if (!/^[a-f0-9]{32}$/.test(call.callId) || call.callId !== callId || call.module !== 'cron' || call.command !== 'trigger'
          || detail.jobId !== jobId || !Number.isSafeInteger(call.revision) || call.revision < revision) throw new Error('Cron trigger call identity or revision changed');
        revision = call.revision;
        if (runId && detail.runId !== runId) throw new Error('Native Cron run identity changed within one trigger call');
        if (typeof detail.runId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(detail.runId)) runId = detail.runId;
        this.execution = { state: 'unsettled', callId, runId };
        if (['failed', 'rejected', 'unknown'].includes(call.status)
          || ['failed', 'skipped', 'cancelled', 'outcome-unknown'].includes(String(detail.executionStatus))
          || (detail.outcome !== undefined && detail.outcome !== 'accepted')) {
          throw new Error(`Cron execution did not succeed: call=${call.status}; execution=${String(detail.executionStatus)}`);
        }
        if (call.status === 'succeeded' && detail.outcome === 'accepted' && detail.executionStatus === 'succeeded' && runId) {
          await this.waitForSnapshot(jobs => jobs.some(job => job.id === jobId && !job.enabled
            && job.lastRun?.success === true && Number.isFinite(Date.parse(job.lastRun.time)) && !job.runningAt));
          this.execution = { state: 'settled', callId: call.callId, runId };
          return { admitted: true, sameCallSettled: true, sameJobNativeSucceeded: true, hasRunId: true };
        }
      }
      await delay(250);
    }
    throw new Error('The same Cron call did not report its correlated native run succeeding within 120 seconds');
  }

  private async reconcileExecution(): Promise<void> {
    if (this.execution.state !== 'unsettled' || !this.jobId) throw new Error('Unsettled Cron execution has no owned job identity');
    const execution = this.execution;
    const calls = execution.callId ? [await this.readCall(execution.callId)] : await this.readTriggerCalls(this.jobId);
    if (calls.length !== 1) throw new Error('Cannot uniquely correlate submitted trigger; preserve the job');
    const call = calls[0]!;
    const detail = record(call.detail);
    if ((execution.callId && call.callId !== execution.callId) || !/^[a-f0-9]{32}$/.test(call.callId)
      || call.module !== 'cron' || call.command !== 'trigger' || detail.jobId !== this.jobId
      || call.status !== 'succeeded' || detail.outcome !== 'accepted' || typeof detail.runId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(detail.runId) || (execution.runId && execution.runId !== detail.runId)
      || !['succeeded', 'failed'].includes(String(detail.executionStatus))) throw new Error('Native execution is active or unknown; deletion is not cancellation');
    await this.waitForSnapshot(jobs => jobs.some(job => job.id === this.jobId && !job.runningAt
      && job.lastRun?.success === (detail.executionStatus === 'succeeded') && Number.isFinite(Date.parse(job.lastRun.time))));
    this.execution = { state: 'settled', callId: call.callId, runId: detail.runId };
  }

  private async readCall(callId: string): Promise<TriggerCall> {
    const reply = await this.electron.fetchHostApi({ method: 'POST', path: '/api/calls/get', body: { callId } });
    if (!reply.ok || reply.data.status !== 200 || !reply.data.ok) throw new Error('The correlated Cron call is unavailable');
    return reply.data.json as TriggerCall;
  }

  private async readTriggerCalls(jobId: string): Promise<TriggerCall[]> {
    const calls: TriggerCall[] = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const reply = await this.electron.fetchHostApi({ method: 'POST', path: '/api/calls/list', body: { module: 'cron', limit: 200, ...(before ? { before } : {}) } });
      const result = record(reply.ok ? reply.data.json : undefined);
      if (!reply.ok || reply.data.status !== 200 || !reply.data.ok || !Array.isArray(result.items)
        || (result.next !== null && (typeof result.next !== 'string' || !/^[a-f0-9]{32}$/.test(result.next)))) throw new Error('Public Cron call catalog is unavailable or malformed');
      calls.push(...(result.items as TriggerCall[]).filter(call => call.module === 'cron' && call.command === 'trigger' && record(call.detail).jobId === jobId));
      if (result.next === null) return calls;
      if (result.next === before) throw new Error('Public Cron call pagination did not advance');
      before = result.next as string;
    }
    throw new Error('Cron call correlation exceeded its bounded 4000-record lookup');
  }

  private async waitForSnapshot(predicate: (jobs: ScheduledJob[]) => boolean): Promise<ScheduledJob[]> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const reply = await this.electron.fetchHostApi({ method: 'GET', path: jobsPath, timeoutMs: 3_000 });
      if (!reply.ok || reply.data.status !== 200 || !reply.data.ok) throw new Error(`Cron provider precondition failed: ${reply.ok ? `HTTP ${reply.data.status}` : `IPC ${reply.error.code}`}`);
      if (privateFields.test(JSON.stringify(reply)) || JSON.stringify(reply).includes(privateCanary)) throw new Error('Public Cron snapshot exposed a forbidden field or private canary');
      const body = record(reply.data.json);
      if (!Array.isArray(body.jobs) || body.jobs.some(value => {
        const job = record(value);
        return typeof job.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(job.id)
          || typeof job.name !== 'string' || typeof job.message !== 'string' || typeof job.enabled !== 'boolean' || !record(job.schedule).kind;
      })) throw new Error('Public Cron snapshot has no valid authoritative job list');
      const jobs = body.jobs as ScheduledJob[];
      if (body.ready !== false && predicate(jobs)) return jobs;
      await delay(250);
    }
    throw new Error('Authoritative Cron snapshot did not reach the expected scheduled-task state');
  }

  route(): string { return new URL(this.electron.page.url()).hash; }
  async visitLegacyRoute(): Promise<void> {
    await this.electron.page.evaluate(() => { window.location.hash = '#/cron'; });
    await this.electron.page.waitForURL(url => url.hash === '#/tasks?tab=scheduled');
  }
}
