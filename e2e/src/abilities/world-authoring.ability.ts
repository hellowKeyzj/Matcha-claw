import { Ability } from '@serenity-js/core';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { repositoryRoot } from '../config/electron.js';
import { UseElectron } from './use-electron.ability.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

type NoOpChange = {
  world: { tenantId: string; worldId: string }; id: string; revision: string; status: 'proposed' | 'validated';
  baseRelease: string; operations: Array<{ kind: 'no_op'; reason: string }>; evidence: unknown[]; cases: unknown[]; rationale: string;
};
type NoOpState = {
  mode: 'resume' | 'propose';
  stage: 'prepared' | 'proposal-submitted' | 'proposed' | 'validation-submitted' | 'validated';
  reason: string; baseRelease: string; head: unknown; change?: NoOpChange; validationAttempts: number;
};
const world = { tenantId: 'local', worldId: 'personal' };

export class WorldAuthoring extends Ability {
  private noOp?: NoOpState;
  constructor(private readonly electron: UseElectron) { super(); }

  async prepareNoOp(scope: string) {
    if (this.noOp) throw new Error('A NoOp attempt already exists; never replace an unresolved request');
    const mode = process.env.E2E_WORLD_NOOP_MODE ?? 'resume';
    const recordPath = process.env.E2E_WORLD_NOOP_RECORD;
    if (mode !== 'resume' && mode !== 'propose') throw new Error('E2E_WORLD_NOOP_MODE must be resume or propose');
    if (mode === 'propose' && recordPath) throw new Error('An existing NoOp record must be resumed, never replaced by a proposal');
    let original: NoOpChange | undefined;
    if (mode === 'resume') {
      if (!recordPath) throw new Error('Resume requires E2E_WORLD_NOOP_RECORD: a public receipt containing noOp.change');
      const receipt = JSON.parse(await readFile(resolve(repositoryRoot, recordPath), 'utf8')) as { noOp?: { change?: NoOpChange } };
      original = receipt.noOp?.change;
      if (!original || typeof original.id !== 'string' || !original.id.trim()
        || typeof original.operations?.[0]?.reason !== 'string' || !original.operations[0].reason.trim()
        || typeof original.rationale !== 'string' || !isDeepStrictEqual(original, {
          world, id: original.id, revision: '1', status: 'proposed', baseRelease: 'release:personal:genesis',
          operations: [{ kind: 'no_op', reason: original.operations[0].reason }], evidence: [], cases: [], rationale: original.rationale,
        })) throw new Error('Resume requires the complete original r1/proposed genesis NoOp, including rationale; no replacement');
      this.noOp = { mode, stage: 'prepared', reason: original.operations[0].reason, baseRelease: original.baseRelease,
        head: undefined, change: original, validationAttempts: 0 };
    }
    const task = JSON.parse(await readFile(resolve(repositoryRoot,
      '.scratch/world-implementation-2026-10-21/s06-task-noop-input-20261025-81b7c54e/task.ready.json'), 'utf8'));
    const registered = await this.query('task_contract', { world, id: task.id, revision: task.revision });
    if (task.scope !== scope || task.budget.maxModelCalls !== '0' || task.budget.maxSourceReads !== '0'
      || !isDeepStrictEqual(registered, { ...task, budget: { maxCost: null, deadline: null, ...task.budget } })) {
      throw new Error('The exact original zero-model/zero-Source Task is required; no registration or fallback');
    }
    const description = await this.query('discover', { includeCapabilities: true }) as {
      world: unknown; status: string; activeRelease: string; activeReleaseHead: unknown;
      editingContext: { definitions: unknown[]; externalContracts: unknown[]; activationLock: { nodes: unknown[] } };
    };
    if (!isDeepStrictEqual(description.world, world) || description.status !== 'ready'
      || description.activeRelease !== 'release:personal:genesis' || !description.activeReleaseHead
      || !description.editingContext || description.editingContext.definitions.length !== 0
      || description.editingContext.externalContracts.length !== 0 || description.editingContext.activationLock.nodes.length !== 0) {
      throw new Error('This zero-effect NoOp requires the real empty genesis context; no baseline or authority is changed');
    }
    const reason = original?.operations[0].reason ?? `E2E independent NoOp ${randomUUID()}`;
    this.noOp = { mode, stage: 'prepared', reason, baseRelease: description.activeRelease, head: description.activeReleaseHead,
      change: original, validationAttempts: 0 };
    const readback = original ? await this.readNoOp(original.id, 'initial') : undefined;
    return { mode, reason, taskValue: JSON.stringify([world, task.id, task.revision, scope]), readback };
  }

  markNoOpSubmission(kind: 'proposal' | 'validation') {
    const state = this.noOp;
    const expected = kind === 'proposal' ? 'prepared' : 'proposed';
    if (!state || state.stage !== expected || (kind === 'proposal' && state.mode !== 'propose')) {
      throw new Error(`Refusing repeated or unresolved NoOp ${kind}`);
    }
    state.stage = kind === 'proposal' ? 'proposal-submitted' : 'validation-submitted';
    if (kind === 'validation') state.validationAttempts++;
    return { phase: state.stage, id: state.change?.id, reason: state.reason, revision: state.change?.revision,
      validationAttempts: state.validationAttempts };
  }

  async readNoOp(id: string, phase: 'initial' | 'proposal' | 'before-validation' | 'validation' | 'replay' | 'refresh') {
    const state = this.noOp;
    const stage = phase === 'initial' ? 'prepared' : phase === 'proposal' ? 'proposal-submitted'
      : phase === 'before-validation' ? 'proposed' : phase === 'validation' ? 'validation-submitted' : 'validated';
    if (!state || state.stage !== stage || (state.change && state.change.id !== id)) {
      throw new Error(`Refusing an unowned or out-of-order NoOp read: ${id}/${phase}`);
    }
    const change = await this.query('change', { id }) as NoOpChange | null;
    // The backend advances only ChangeSet revision/status; every other field, including rationale, is immutable here.
    const validated = state.change ? { ...state.change, revision: '2', status: 'validated' } : undefined;
    const expected = phase === 'initial' && isDeepStrictEqual(change, validated) ? validated
      : phase === 'validation' ? validated : state.change ?? {
        world, id, revision: '1', status: 'proposed', baseRelease: state.baseRelease,
        operations: [{ kind: 'no_op', reason: state.reason }], evidence: [], cases: [], rationale: change?.rationale,
      };
    if (!change || typeof change.rationale !== 'string' || !isDeepStrictEqual(change, expected)) {
      throw new Error(`The complete owned NoOp ${id}/${phase} differs; preserve this identity and never resubmit`);
    }
    const description = await this.query('discover', { includeCapabilities: false }) as { world: unknown; status: string; activeRelease: string; activeReleaseHead: unknown };
    if (!isDeepStrictEqual(description.world, world) || description.status !== 'ready'
      || description.activeRelease !== state.baseRelease || !isDeepStrictEqual(description.activeReleaseHead, state.head)) {
      throw new Error('NoOp validation must not publish or move the active release head');
    }
    state.change = change;
    state.stage = change.status;
    return { id, revision: change.revision, status: change.status, exact: true, activeReleaseUnchanged: true,
      phase: phase === 'initial' || phase === 'proposal' ? `${phase}-${change.status}-exact`
        : phase === 'replay' ? 'validated-read-only-replay' : `${phase}-confirmed`,
      validationAttempts: state.validationAttempts, change, activeReleaseHead: description.activeReleaseHead };
  }

  private async query(kind: string, request: unknown): Promise<unknown> {
    const reply = await this.electron.fetchHostApi({ path: '/api/world/query', method: 'POST', body: { world, query: { kind, request } }, timeoutMs: 10_000 });
    if (!reply.ok) throw new Error(`World ${kind} transport failed: ${reply.error.code}`);
    const body = reply.data.json as { success?: boolean; data?: { kind: string; result: unknown }; error?: { code: string; stage: string; diagnosticId: string } };
    if (reply.data.status !== 200 || !reply.data.ok || body.success !== true || body.data?.kind !== kind) {
      throw new Error(`World ${kind} read failed: HTTP ${reply.data.status}; ${JSON.stringify(body.error ?? null)}`);
    }
    return body.data.result;
  }

  async uploadDefinition(batch: 'first' | 'replacement', scope: string): Promise<void> {
    if (!scope.trim()) throw new Error('Select an existing authorized World scope before importing a definition');
    const definition = {
      reference: { world: { tenantId: 'local', worldId: 'personal' }, id: `function:e2e-authoring:${batch}`, revision: '1' },
      scope,
      validTime: { from: '2026-10-26T00:00:00.000000000Z', to: null },
      body: {
        kind: 'function',
        body: {
          name: `E2E authoring ${batch}`,
          parameters: [],
          resultType: { kind: 'integer' },
          expression: { kind: 'literal', value: { kind: 'integer', value: batch === 'first' ? '1' : '2' } },
          effects: ['pure'],
          maxEvaluations: '1',
        },
      },
      dependencies: [],
      evidence: [],
      previousRef: null,
      lifecycle: { kind: 'available' },
    };
    const digestInput = ['world.definition.v1', definition.reference, definition.scope, definition.validTime,
      definition.body, definition.dependencies, definition.previousRef, definition.lifecycle];
    const contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(canonical(digestInput))).digest('hex')}`;
    await this.electron.page.getByLabel(/^(定义 JSON 文件|Definition JSON file)$/).setInputFiles({
      name: `world-${batch}.json`, mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...definition, contentDigest }, null, 2)),
    });
  }
}
