import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { UseElectron } from './use-electron.ability.js';

const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } as const;
type Identity = { endpoint: typeof endpoint; agentId: 'main'; sessionKey: string };
type TaskItem = { id: string; subject: string; description: string; status: string };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function snapshot(value: unknown): TaskItem[] {
  const body = record(value);
  if (!Array.isArray(body.todos) || !Array.isArray(body.tasks) || !body.tasks.every(value => {
    const task = record(value);
    return typeof task.id === 'string' && task.id.length > 0 && typeof task.subject === 'string'
      && typeof task.description === 'string' && ['pending', 'in_progress', 'completed', 'deleted'].includes(String(task.status));
  })) throw new Error('The public task snapshot has an invalid task/todo collection');
  return body.tasks as TaskItem[];
}

export class TasksLifecycle extends Ability {
  readonly subject = `E2E task lifecycle ${randomUUID()}`;
  readonly description = `Create, complete, and delete only ${this.subject}`;
  readonly privateMarker = `private-task-request-${randomUUID()}`;
  private identity?: Identity;
  private taskId?: string;
  private pending?: 'create' | 'complete' | 'delete';

  constructor(private readonly electron: UseElectron) { super(); }

  async rejectUnsafeRequests() {
    const identity: Identity = { endpoint, agentId: 'main', sessionKey: 'agent:main:invalid' };
    const results = [];
    for (const operationId of ['tasks.unsupported', 'tasks.create']) {
      results.push(await this.rejectInvalidInput(operationId, identity, { subject: this.subject, description: this.description }));
    }
    return { rejected: results.map(result => result.rejected), privateDataWasExposed: results.some(result => result.privateDataWasExposed) };
  }

  async rejectUnsafeUpdate() {
    this.requireOwn(await this.listTasks(), 'completed');
    const result = await this.rejectInvalidInput('tasks.update', this.identity!, { taskId: this.taskId, status: 'completed' });
    this.requireOwn(await this.listTasks(), 'completed');
    return result;
  }

  private async rejectInvalidInput(operationId: string, identity: Identity, input: Record<string, unknown>) {
    const reply = await this.electron.fetchHostApi({
      path: '/api/capabilities/execute', method: 'POST',
      body: {
        id: 'task.management', operationId,
        scope: { kind: 'session', identity }, target: { kind: 'task-manager', identity },
        input: { sessionIdentity: identity, ...input, workspaceDir: this.privateMarker },
      },
    });
    const body = record(reply.ok ? reply.data.json : undefined);
    const failure = record(body.failure);
    const projected = JSON.stringify(reply);
    return {
      rejected: reply.ok && reply.data.status === 400 && reply.data.ok === false
        && body.success === false && body.error === 'The task request parameters are invalid'
        && Object.keys(body).length === 3 && Object.keys(failure).length === 3
        && failure.stage === 'task_request' && failure.code === 'invalid_params' && failure.delivery === 'notSent',
      privateDataWasExposed: projected.includes(this.privateMarker) || projected.includes('workspaceDir'),
    };
  }

  async selectExistingSession(): Promise<void> {
    const reply = await this.electron.fetchHostApi({
      path: '/api/capabilities/execute', method: 'POST', timeoutMs: 60_000,
      body: {
        id: 'session.management', operationId: 'sessions.list',
        scope: { kind: 'runtime-instance', endpoint }, target: { kind: 'runtime-endpoint' }, input: { endpoint },
      },
    });
    const catalog = record(reply.ok ? reply.data.json : undefined);
    if (!reply.ok || reply.data.status !== 200 || !reply.data.ok || !Array.isArray(catalog.sessions)) {
      throw new Error('Tasks lifecycle requires a ready OpenClaw public session catalog');
    }
    // Bind once to a real catalog identity. A failed tasks.list never tries another identity.
    const candidate = catalog.sessions.map(value => record(record(value).sessionIdentity)).find(identity => {
      const actual = record(identity.endpoint);
      return identity.agentId === 'main' && typeof identity.sessionKey === 'string' && identity.sessionKey.length > 0
        && actual.kind === endpoint.kind && actual.runtimeAdapterId === endpoint.runtimeAdapterId
        && actual.runtimeInstanceId === endpoint.runtimeInstanceId;
    });
    if (!candidate) throw new Error('An existing local OpenClaw main session is required; no model prompt or replacement session is created');
    this.identity = { endpoint, agentId: 'main', sessionKey: candidate.sessionKey as string };
    if ((await this.listTasks()).some(task => this.isOwn(task))) throw new Error('The unique lifecycle task already exists');
  }

  async createOwnTask() {
    if (this.pending || this.taskId) throw new Error('Refusing a second TaskCreate submission');
    this.pending = 'create';
    const created = await this.request('tasks.create', { subject: this.subject, description: this.description });
    const task = record(created.task);
    if (created.outcome !== 'applied' || typeof task.id !== 'string' || !task.id || !this.isOwn(task)) {
      throw new Error('TaskCreate did not confirm an applied owned task; unknown/rejected is not retried or deleted');
    }
    this.taskId = task.id;
    this.pending = undefined;
    this.requireOwn(snapshot(created.snapshot), 'pending');
    this.requireOwn(await this.listTasks(), 'pending');
    return { id: this.taskId, subject: this.subject, description: this.description, status: 'pending' };
  }

  async completeOwnTask() {
    if (this.pending) throw new Error('A lifecycle mutation is unresolved');
    this.requireOwn(await this.listTasks(), 'pending');
    this.pending = 'complete';
    const updated = await this.request('tasks.update', { taskId: this.taskId, status: 'completed' });
    if (updated.outcome !== 'applied') throw new Error('TaskUpdate completion is unresolved; preserve the exact task');
    this.pending = undefined;
    this.requireOwn(snapshot(updated.snapshot), 'completed');
    this.requireOwn(await this.listTasks(), 'completed');
    return true;
  }

  markDeleteSubmitted(): void {
    if (!this.taskId || this.pending) throw new Error('No settled owned lifecycle task may be deleted');
    this.pending = 'delete';
  }

  async confirmOwnTaskIsAbsent() {
    const tasks = await this.listTasks();
    if (tasks.some(task => task.id === this.taskId || this.isOwn(task))) {
      throw new Error('Task Center deletion is not confirmed; do not resubmit');
    }
    this.pending = undefined;
    this.taskId = undefined;
    return true;
  }

  async cleanupTarget() {
    if (this.pending === 'delete') {
      await this.confirmOwnTaskIsAbsent();
      return false;
    }
    if (this.pending) throw new Error(`Lifecycle ${this.pending} outcome is unresolved; no mutation is replayed and no task is blindly deleted`);
    if (!this.taskId) return false;
    const task = (await this.listTasks()).find(task => task.id === this.taskId);
    if (!task) { this.taskId = undefined; return false; }
    if (!this.isOwn(task)) throw new Error('Refusing cleanup: exact task ID no longer has this case UUID and description');
    return { id: this.taskId, subject: this.subject, description: this.description, status: task.status };
  }

  async scrollDirectory(selector: string, reset: boolean): Promise<void> {
    await this.electron.page.locator(selector).evaluate((element, reset) => {
      element.scrollTop = reset ? 0 : element.scrollTop + Math.max(element.clientHeight * 0.75, 96);
    }, reset);
  }

  private isOwn(task: Record<string, unknown> | TaskItem): boolean {
    return task.subject === this.subject && task.description === this.description;
  }

  private requireOwn(tasks: TaskItem[], status: string): void {
    if (tasks.filter(task => task.id === this.taskId && this.isOwn(task) && task.status === status).length !== 1) {
      throw new Error(`The authoritative lifecycle task is not uniquely ${status}`);
    }
  }

  private async listTasks(): Promise<TaskItem[]> { return snapshot(await this.request('tasks.list', {})); }

  private async request(operationId: 'tasks.list' | 'tasks.create' | 'tasks.update', input: Record<string, unknown>) {
    if (!this.identity) throw new Error('No authoritative lifecycle session identity has been selected');
    const reply = await this.electron.fetchHostApi({
      path: '/api/capabilities/execute', method: 'POST', timeoutMs: 60_000,
      body: {
        id: 'task.management', operationId,
        scope: { kind: 'session', identity: this.identity }, target: { kind: 'task-manager', identity: this.identity },
        input: { sessionIdentity: this.identity, ...input },
      },
    });
    if (!reply.ok || reply.data.status !== 200 || !reply.data.ok) {
      const body = record(reply.ok ? reply.data.json : undefined);
      const failure = record(body.failure);
      const stage = /^(admission|runtime|session_lookup|task_request|native_start|native_control|native_read|response|transport)$/;
      const code = /^(admission_closed|unsupported|runtime_not_ready|owner_unavailable|invalid_identity|ownership_mismatch|not_found|connect_failed|connection_closed|upgrade_failed|deadline|cancelled|authentication_failed|unsupported_protocol|method_not_found|invalid_params|native_start_failed|native_instance_absent|native_instance_changed|native_cleanup_unconfirmed|session_closed|native_control_error|native_response_lost|task_io|todo_io|task_native_schema|task_lock_conflict|todo_conflict|todo_session_busy|task_dependency_missing|todo_owner_inactive|todo_persistence_disabled|receipt_invalid|protocol|transport|request_rejected|remote_error)$/;
      const safe = typeof failure.stage === 'string' && stage.test(failure.stage)
        && typeof failure.code === 'string' && code.test(failure.code)
        && Object.keys(failure).every(key => ['stage', 'code', 'delivery', 'rpcCode'].includes(key))
        && (!Object.hasOwn(failure, 'delivery') || ['notSent', 'sent', 'unknown', 'responseReceived'].includes(String(failure.delivery)))
        && (!Object.hasOwn(failure, 'rpcCode') || Number.isSafeInteger(failure.rpcCode));
      const diagnostic = safe ? JSON.stringify({ stage: failure.stage, code: failure.code,
        ...(failure.delivery === undefined ? {} : { delivery: failure.delivery }),
        ...(failure.rpcCode === undefined ? {} : { rpcCode: failure.rpcCode }) })
        : Object.hasOwn(body, 'failure') ? 'invalid' : 'absent';
      throw new Error(`${operationId} requires a ready real OpenClaw task-manager: ${reply.ok ? `HTTP ${reply.data.status}` : `IPC ${reply.error.code}`}; failure=${diagnostic}; no identity fallback`);
    }
    return record(reply.data.json);
  }
}
