import { Ability } from '@serenity-js/core';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UseElectron, type PublicHostApiReply } from './use-electron.ability.js';

const scope = {
  kind: 'runtime-instance',
  endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
} as const;
type Mutation = 'create-team' | 'create-run' | 'purge-run' | 'delete-team';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Team lifecycle public response is not an object');
  return value as Record<string, unknown>;
}

function body(reply: PublicHostApiReply, status = 200): Record<string, unknown> {
  if (!reply.ok) throw new Error('Team lifecycle public IPC is unavailable');
  if (reply.data.status !== status || !reply.data.ok) throw new Error(`Team lifecycle expected HTTP ${status}, received ${reply.data.status}`);
  return record(reply.data.json);
}

function matchesIdentity(reference: unknown, hash: unknown, identity: string): boolean {
  return reference === identity && hash === null
    || reference === null && hash === createHash('sha256').update(identity).digest('hex');
}

function trustedSkillRoot(): string {
  const packageRoot = process.env.TEAM_LIFECYCLE_SKILL_ROOT?.trim();
  if (!packageRoot || !isAbsolute(packageRoot)) {
    throw new Error('Precondition: TEAM_LIFECYCLE_SKILL_ROOT must identify an operator-reviewed existing TeamSkill; no Skill was installed');
  }
  return resolve(packageRoot);
}

export class TeamLifecycle extends Ability {
  private name = '';
  private packageRoot = '';
  private teamId = '';
  private runId = '';
  private deadline = 0;
  private teamsBefore: string[] = [];
  private teamMaterialized = false;
  private runCreated = false;
  private runPurged = false;
  private teamTombstoned = false;
  private othersUnchanged = false;
  private cleanupStarted = false;
  private reviewedSkill?: { packageRoot: string; identity: string; warnings: number };
  private graphNodeIds: string[] = [];
  private pendingMutation?: { operation: Mutation; baseline: Set<string>; callId?: string };

  constructor(private readonly electron: UseElectron) { super(); }

  private timeout(): number {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new Error('Owned Team lifecycle observation budget expired');
    return Math.min(10_000, remaining);
  }

  async reviewTrustedSkill() {
    this.deadline = Date.now() + 50_000;
    const packageRoot = trustedSkillRoot();
    const authorization = body(await this.electron.fetchHostApi({
      path: '/api/team/skill', method: 'POST', timeoutMs: this.timeout(),
      body: { operation: 'team.skill.authorize', packageRoot },
    }));
    const selectionId = authorization.selectionId;
    if (typeof selectionId !== 'string' || !/^teamskill:v1:[a-f0-9]{64}$/.test(selectionId)) {
      throw new Error('TeamSkill authorization did not return a sealed selection');
    }
    const validation = body(await this.electron.fetchHostApi({
      path: '/api/team/skill', method: 'POST', timeoutMs: this.timeout(),
      body: { operation: 'team.skill.validate', selectionId },
    }));
    if (validation.status !== 'valid') throw new Error('Precondition: the selected trusted TeamSkill is not valid');
    const skill = record(validation.package);
    if (skill.selectionId !== selectionId || skill.kind !== 'team-skill'
      || typeof skill.name !== 'string' || !skill.name || typeof skill.version !== 'string' || !skill.version) {
      throw new Error('TeamSkill validation did not confirm the selected package identity');
    }
    const dependency = body(await this.electron.fetchHostApi({
      path: '/api/team/skill', method: 'POST', timeoutMs: this.timeout(),
      body: { operation: 'team.skill.dependency-plan', selectionId, scope },
    }));
    if (dependency.status !== 'available') throw new Error('Precondition: TeamSkill dependency planning is unavailable');
    const plan = record(dependency.plan);
    if (plan.selectionId !== selectionId || plan.packageName !== skill.name || plan.packageVersion !== skill.version
      || plan.canProceed !== true || !Array.isArray(plan.items)
      || plan.items.some(item => record(item).severity === 'blocker')) {
      throw new Error('Precondition: trusted TeamSkill dependencies are not ready; no dependency was installed');
    }
    this.reviewedSkill = {
      packageRoot, identity: `${skill.name}@${skill.version}`,
      warnings: plan.items.filter(item => record(item).severity === 'warning').length,
    };
    return { selectionSealed: true, packageValid: true, dependenciesReady: true };
  }

  async reserve(teamsBefore: string[]) {
    if (this.pendingMutation || this.teamMaterialized) throw new Error('Team lifecycle Ability still owns an earlier lifecycle; do not overwrite it');
    await this.reviewTrustedSkill();
    this.deadline = Date.now() + 90_000;
    this.name = `e2e-team-lifecycle-${randomUUID()}`;
    this.packageRoot = trustedSkillRoot();
    this.teamsBefore = [...teamsBefore].sort();
    if (teamsBefore.includes(this.name)) throw new Error('Team lifecycle UUID already exists in the UI');
    return { name: this.name, packageRoot: this.packageRoot };
  }

  async completePicker() {
    if (!this.packageRoot || this.pendingMutation) throw new Error('TeamSkill picker has no reserved trusted source');
    await this.electron.completeNativeDirectoryPicker(this.packageRoot);
  }

  confirmReview(selectedPath: string, packageIdentity: string, dependencies: string, primaryLabel: string) {
    const reviewed = this.reviewedSkill;
    if (!reviewed || reviewed.packageRoot !== this.packageRoot || resolve(selectedPath) !== this.packageRoot
      || packageIdentity !== reviewed.identity || dependencies !== `0 blocker · ${reviewed.warnings} warning`
      || primaryLabel !== '创建团队') {
      throw new Error('Trusted UI review is not a fresh create with ready dependencies; existing/replacement teams were not touched');
    }
  }

  async arm(operation: Mutation, uiRunId?: string) {
    if (this.pendingMutation) throw new Error('Team lifecycle has an unsettled mutation; never submit it again');
    if (operation === 'create-team' ? !this.name || Boolean(this.teamId)
      : operation === 'delete-team' ? !this.teamMaterialized || !this.runPurged || this.teamTombstoned
        : !this.runCreated || this.runPurged) {
      throw new Error(`Cannot submit ${operation} without its exact confirmed owned resource`);
    }
    if (operation === 'purge-run'
      && (new URL(this.electron.page.url()).hash !== `#/teams/${this.teamId}` || uiRunId !== this.runId)) {
      throw new Error('Refusing to purge a different UI Team or selected run');
    }
    this.pendingMutation = { operation, baseline: new Set((await this.listCalls()).map(call => String(call.callId))) };
  }

  async confirmCreated(heading: string, uiRunId: string) {
    if (!this.pendingMutation || !['create-team', 'create-run'].includes(this.pendingMutation.operation)) {
      throw new Error('No UI creation is pending');
    }
    const match = new URL(this.electron.page.url()).hash.match(/^#\/teams\/(team-\d+)$/);
    if (heading !== this.name || !match || !/^teamrun-[a-zA-Z0-9._-]+$/.test(uiRunId)
      || (this.teamId && this.teamId !== match[1]) || (this.runId && this.runId !== uiRunId)) {
      throw new Error('UI creation did not expose the exact new UUID Team and its automatically created run');
    }
    this.teamId = match[1];
    this.runId = uiRunId;
    await this.reconcilePendingMutation();
    return { teamId: this.teamId, runId: this.runId, nodeIds: [...this.graphNodeIds] };
  }

  private async execute(operationId: string, target: Record<string, unknown>, input: Record<string, unknown>) {
    // Only public read operations live here; all lifecycle mutations are UI clicks.
    if (!['team.runList', 'team.runSnapshot', 'team.designSnapshot'].includes(operationId)) throw new Error('Team lifecycle does not issue API mutations');
    return this.electron.fetchHostApi({ path: '/api/capabilities/execute', method: 'POST', timeoutMs: this.timeout(),
      body: { id: 'team.runtime', operationId, scope, target, input } });
  }

  private async listCalls() {
    const page = body(await this.electron.fetchHostApi({ path: '/api/calls/list', method: 'POST', timeoutMs: this.timeout(),
      body: { module: 'organization', limit: 50 } }));
    if (!Array.isArray(page.items)) throw new Error('Organization public call page is unavailable');
    return page.items.map(record);
  }

  private hasOwnIdentity(detail: Record<string, unknown>, withRun: boolean) {
    const teamMatches = matchesIdentity(detail.teamId, detail.teamIdHash, this.teamId);
    const runMatches = matchesIdentity(detail.runId, detail.runIdHash, this.runId);
    return withRun
      ? runMatches && (teamMatches || detail.teamId === null && detail.teamIdHash === null)
      : teamMatches && detail.runId === null && detail.runIdHash === null;
  }

  private async observeCall(command: string, outcomes: string[], withRun: boolean) {
    const pending = this.pendingMutation;
    if (!pending || !this.teamId || (withRun && !this.runId)) {
      throw new Error('Unknown UI mutation has no complete owned identity for read-only reconciliation');
    }
    while (Date.now() < this.deadline) {
      if (!pending.callId) {
        const candidates = (await this.listCalls()).filter(call => !pending.baseline.has(String(call.callId))
          && call.module === 'organization' && call.command === command && this.hasOwnIdentity(record(call.detail), withRun));
        if (candidates.length > 1) throw new Error(`Duplicate own ${command} calls; no mutation will be retried`);
        if (candidates.length === 1) {
          const callId = candidates[0].callId;
          if (typeof callId !== 'string' || !/^[a-f0-9]{32}$/.test(callId)) throw new Error('Owned UI mutation callId is invalid');
          pending.callId = callId;
        }
      }
      if (pending.callId) {
        const call = body(await this.electron.fetchHostApi({ path: '/api/calls/get', method: 'POST', timeoutMs: this.timeout(),
          body: { callId: pending.callId } }));
        const detail = record(call.detail);
        if (call.callId !== pending.callId || call.module !== 'organization' || call.command !== command
          || !this.hasOwnIdentity(detail, withRun)
          || command === 'team.runCreate' && !matchesIdentity(detail.teamId, detail.teamIdHash, this.teamId)) {
          throw new Error('Organization observation changed the exact owned call or resource identity');
        }
        if (call.status === 'succeeded') {
          if (!outcomes.includes(String(detail.outcome))) throw new Error(`Owned ${command} did not confirm its required business outcome`);
          return detail;
        }
        if (!['received', 'accepted', 'running', 'waiting'].includes(String(call.status))) {
          throw new Error(`Owned ${command} is ${String(call.status)}; retain this same call for reconciliation`);
        }
      }
      await delay(150);
    }
    throw new Error(`Owned UI mutation ${command} did not settle within the observation budget; do not resubmit`);
  }

  private async confirmNativeProjection() {
    const listing = body(await this.execute('team.runList', { kind: 'team', teamId: this.teamId }, { teamId: this.teamId }));
    if (listing.teamId !== this.teamId || !Array.isArray(listing.runs) || listing.runs.length !== 1) {
      throw new Error('UI-created Team did not have exactly its automatically created run');
    }
    const listedRun = record(listing.runs[0]);
    // The public producer redacts native paths and exposes the Team revision, not a fixed run revision.
    if (listedRun.runId !== this.runId || listedRun.status !== 'created' || listedRun.sourcePath !== ''
      || typeof listedRun.revision !== 'number' || !Number.isSafeInteger(listedRun.revision) || listedRun.revision < 0) {
      throw new Error('UI-created run did not expose its exact created identity, Team revision and redacted source');
    }
    const bindings = this.requireBindings(listedRun.sessions);
    const projection = body(await this.electron.fetchHostApi({ path: '/api/team/public', method: 'POST', timeoutMs: this.timeout(),
      body: { teamId: this.teamId, runId: this.runId } }));
    const graph = record(projection.graph);
    if (projection.teamId !== this.teamId || projection.runId !== this.runId || projection.runtime !== 'confirmed'
      || projection.teamRevision !== listedRun.revision
      || !Array.isArray(graph.nodes) || !graph.nodes.length || !Array.isArray(graph.edges)) {
      throw new Error('Public graph was not linked to the exact UI-created native runtime and Team revision');
    }
    const nodeIds = graph.nodes.map(node => record(node).nodeId);
    if (!nodeIds.every((id): id is string => typeof id === 'string' && id.length > 0)
      || new Set(nodeIds).size !== nodeIds.length
      || !graph.nodes.some(node => record(node).kind === 'start') || !graph.nodes.some(node => record(node).kind === 'end')
      || !graph.edges.every(edge => nodeIds.some(id => id === record(edge).sourceNodeId)
        && nodeIds.some(id => id === record(edge).targetNodeId))) {
      throw new Error('Public TeamRun graph has missing node identities or dangling edges');
    }
    const snapshot = await this.snapshot();
    const run = record(snapshot.run);
    const design = body(await this.execute('team.designSnapshot', { kind: 'team', teamId: this.teamId },
      { teamId: this.teamId, runId: this.runId }));
    if (run.runId !== this.runId || run.status !== 'created' || run.revision !== listedRun.revision || run.sourcePath !== ''
      || record(snapshot.startGate).status !== 'intake'
      || design.success !== true || design.teamId !== this.teamId || design.runId !== this.runId
      || record(design.startGate).status !== 'intake' || design.designEpoch !== null || design.runtimeError !== null
      || typeof design.graphVersion !== 'string' || !/^[a-f0-9]{64}$/.test(design.graphVersion)) {
      throw new Error('UI-created TeamRun and its canvas design did not remain at the exact Intake start gate');
    }
    for (const projected of [snapshot, design]) {
      const projectedGraph = record(projected.graph);
      if (projectedGraph.runId !== this.runId || projectedGraph.graphId !== graph.graphId
        || !Array.isArray(projectedGraph.nodes)
        || JSON.stringify(projectedGraph.nodes.map(node => record(node).nodeId).sort()) !== JSON.stringify([...nodeIds].sort())
        || JSON.stringify(this.requireBindings(projected.roles)) !== JSON.stringify(bindings)) {
        throw new Error('Run list, public graph, runtime snapshot and canvas design disagree on the owned graph or full role sessions');
      }
    }
    this.graphNodeIds = [...nodeIds].sort();
  }

  private requireBindings(value: unknown): string[] {
    if (!Array.isArray(value) || !value.length) throw new Error('Owned TeamRun role sessions are unavailable');
    const roleSessions = new Set<string>();
    const bindings = value.map(role => {
      const binding = record(role);
      const identity = record(binding.sessionIdentity);
      const endpoint = record(identity.endpoint);
      const endpointRef = record(binding.endpointRef);
      const roleSession = JSON.stringify([binding.roleId, binding.sessionRef]);
      if (binding.teamId !== this.teamId || binding.runId !== this.runId || binding.status !== 'available'
        || ![binding.roleId, binding.sessionRef, binding.agentId, binding.localSessionId, binding.endpointSessionId]
          .every(field => typeof field === 'string' && field.length > 0)
        || identity.agentId !== binding.agentId || identity.sessionKey !== binding.localSessionId
        || ![endpoint, endpointRef].every(ref => ref.kind === scope.endpoint.kind
          && ref.runtimeAdapterId === scope.endpoint.runtimeAdapterId && ref.runtimeInstanceId === scope.endpoint.runtimeInstanceId)
        || roleSessions.has(roleSession)) {
        throw new Error('Owned TeamRun has an incomplete, foreign or duplicate role/session binding');
      }
      roleSessions.add(roleSession);
      return JSON.stringify([binding.teamId, binding.runId, binding.roleId, binding.sessionRef, binding.status,
        endpoint.kind, endpoint.runtimeAdapterId, endpoint.runtimeInstanceId,
        binding.agentId, binding.localSessionId, binding.endpointSessionId]);
    });
    if (!value.some(role => record(role).roleId === 'leader')) throw new Error('Owned TeamRun has no native leader session');
    return bindings.sort();
  }

  private async snapshot() {
    return body(await this.execute('team.runSnapshot', { kind: 'team-run', runId: this.runId }, { runId: this.runId, eventLimit: 0 }));
  }

  async reconcilePendingMutation() {
    const pending = this.pendingMutation;
    if (!pending) return;
    if (pending.operation === 'create-team') {
      const detail = await this.observeCall('team.provisionAgents', ['materialized'], false);
      const provision = record(detail.provision);
      if (provision.nativeInstalled !== true || provision.commit !== 'committed') {
        throw new Error('UI provisioning did not confirm native installation and durable materialization');
      }
      this.teamMaterialized = true;
      // The same UI click continues into createRun. It must never be submitted a second time.
      this.pendingMutation = { operation: 'create-run', baseline: pending.baseline };
      await this.reconcilePendingMutation();
      return;
    }
    if (pending.operation === 'create-run') {
      await this.observeCall('team.runCreate', ['created'], true);
      await this.confirmNativeProjection();
      this.runCreated = true;
    } else if (pending.operation === 'purge-run') {
      await this.observeCall('team.runDelete', ['purged'], true);
      await this.confirmRunAbsent();
      this.runPurged = true;
    } else {
      await this.observeCall('team.delete', ['tombstoned'], false);
      this.teamTombstoned = true;
    }
    this.pendingMutation = undefined;
  }

  private async confirmRunAbsent() {
    const listing = body(await this.execute('team.runList', { kind: 'team', teamId: this.teamId }, { teamId: this.teamId }));
    const missing = await this.electron.fetchHostApi({ path: '/api/team/public', method: 'POST', timeoutMs: this.timeout(),
      body: { teamId: this.teamId, runId: this.runId } });
    const absent: Record<string, unknown> = missing.ok ? record(missing.data.json) : {};
    if (listing.teamId !== this.teamId || !Array.isArray(listing.runs) || listing.runs.length !== 0
      || !missing.ok || missing.data.status !== 404 || missing.data.ok
      || Object.keys(absent).length !== 2 || absent.success !== false || absent.error !== 'Team public projection is unavailable') {
      throw new Error('Purged owned TeamRun remains in its own public list or graph projection');
    }
  }

  confirmOtherTeams(names: string[], ownTeamPresent: boolean) {
    const own = names.filter(name => name === this.name);
    const others = names.filter(name => name !== this.name).sort();
    if (own.length !== (ownTeamPresent ? 1 : 0) || JSON.stringify(others) !== JSON.stringify(this.teamsBefore)) {
      throw new Error('Own UUID Team UI membership or the untouched foreign Team collection changed');
    }
    if (!ownTeamPresent) this.othersUnchanged = true;
  }

  async prepareCleanup() {
    if (!this.cleanupStarted) {
      this.cleanupStarted = true;
      this.deadline = Date.now() + 20_000;
    }
    await this.reconcilePendingMutation();
    return {
      purgeRun: this.runCreated && !this.runPurged,
      deleteTeam: this.teamMaterialized && this.runPurged && !this.teamTombstoned,
    };
  }

  result() {
    if (!this.teamTombstoned || !this.runPurged || !this.othersUnchanged || this.pendingMutation) {
      throw new Error(`Owned UI lifecycle is incomplete: team=${this.teamId || 'unconfirmed'}; run=${this.runId || 'unconfirmed'}`);
    }
    return {
      creationPath: 'ui', materializationAccepted: true, materializationCommitted: true, runCreated: true,
      runtimeConfirmed: true, roleSessionsBound: true, graphProjected: true, startGate: 'intake',
      modelExecution: 'not_requested', businessCompletion: 'not_asserted',
      cancellation: 'not_available_before_start', runPurged: true, teamTombstoned: true, otherTeamsUnchanged: true,
    };
  }
}
