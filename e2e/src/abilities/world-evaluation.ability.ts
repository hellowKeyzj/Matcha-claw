import { Ability } from '@serenity-js/core';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { licensedProfileRoot, repositoryRoot } from '../config/electron.js';
import type { UseElectron } from './use-electron.ability.js';

const world = { tenantId: 'local', worldId: 'personal' };
const commitId = 'commit:eval-admin-ready-20261026-4e92d6a1';
const inputSha256 = 'b987c9a5beb0e909198c2cb77bb6357be5bd8f2c0df7b85dcca515badd453d05';
const inputPath = resolve(repositoryRoot,
  '.scratch/world-implementation-2026-10-21/eval-admin-ready-20261026-4e92d6a1/evaluation-admin.json');
type Status = { outcome: 'available'; world: typeof world; configured: boolean; commitId: string | null };
type Phase = 'idle' | 'unconfigured' | 'selecting' | 'preview' | 'cancelling' | 'cancelled'
  | 'submitting' | 'confirmed' | 'existing-config' | 'returned' | 'stopped';

export class WorldEvaluation extends Ability {
  private phase: Phase = 'idle';
  private mode: 'new-config' | 'existing-config' | null = null;
  private selections = 0;
  private submissionAttempts = 0;
  private status: Status | null = null;

  constructor(private readonly electron: UseElectron) { super(); }

  async begin() {
    if (this.phase !== 'idle' || resolve(this.electron.profileRoot) !== resolve(licensedProfileRoot)) {
      throw new Error('Evaluation requires the dedicated licensed profile and an unused attempt');
    }
    await this.verifyInput();
    this.status = await this.readStatus();
    this.mode = this.status.configured ? 'existing-config' : 'new-config';
    this.phase = this.status.configured ? 'existing-config' : 'unconfigured';
    return this.evidence();
  }

  select() {
    if (this.mode !== 'new-config' || !['unconfigured', 'cancelled'].includes(this.phase) || this.selections >= 2 || this.submissionAttempts !== 0) {
      throw new Error('Refusing another evaluation selection after an unresolved or submitted request');
    }
    this.phase = 'selecting';
    return this.evidence();
  }

  async completePicker() {
    if (this.phase !== 'selecting') throw new Error('No owned evaluation file selection');
    await this.verifyInput();
    await this.electron.completeNativeFilePicker(inputPath, '导入管理员提供的评测身份配置');
    this.selections++;
  }

  preview() {
    if (this.phase !== 'selecting' || this.selections === 0) throw new Error('Evaluation preview has no completed native selection');
    this.phase = 'preview';
    return this.evidence();
  }

  arm(action: 'cancel' | 'submit') {
    if (this.phase !== 'preview' || this.submissionAttempts !== 0 || (action === 'submit' && this.selections !== 2)) {
      throw new Error('Refusing an out-of-order or repeated evaluation confirmation');
    }
    this.phase = action === 'cancel' ? 'cancelling' : 'submitting';
    if (action === 'submit') {
      this.submissionAttempts++;
      this.status = null;
    }
    return this.evidence();
  }

  async observe(at: 'cancelled' | 'confirmed' | 'existing-config' | 'returned') {
    const allowed = at === 'cancelled' ? this.phase === 'cancelling'
      : at === 'confirmed' ? this.phase === 'submitting'
        : at === 'existing-config' ? this.phase === 'existing-config'
          : this.phase === 'confirmed' || this.phase === 'existing-config';
    if (!allowed) throw new Error(`Refusing an unowned evaluation observation at ${at}`);
    this.status = await this.readStatus();
    if (this.status.configured !== (at !== 'cancelled')) {
      this.phase = 'stopped';
      throw new Error(`Evaluation ${at} durable status differs; preserve ${commitId}, do not resubmit`);
    }
    this.phase = at;
    return this.evidence();
  }

  evidence() {
    return {
      phase: this.phase === 'submitting' ? 'submission-unconfirmed' : this.phase,
      mode: this.mode, world, commitId, inputSha256, selections: this.selections, submissionAttempts: this.submissionAttempts,
      status: this.status,
      mayLeave: ['idle', 'unconfigured', 'preview', 'cancelled', 'confirmed', 'existing-config', 'returned'].includes(this.phase),
      // Durable false does not expose Main's unresolved original custody, including a prior run.
      custody: 'not-observable-from-status',
    };
  }

  private async verifyInput() {
    const bytes = await readFile(inputPath);
    if (bytes.length !== 2093 || createHash('sha256').update(bytes).digest('hex') !== inputSha256) {
      this.phase = 'stopped';
      throw new Error('The approved original evaluation input changed; no replacement identity or permission edits');
    }
  }

  private async readStatus(): Promise<Status> {
    const value: unknown = await this.electron.page.evaluate(async world => {
      const bridge = (window as unknown as {
        electron: { ipcRenderer: { invoke(channel: string, request: unknown): Promise<unknown> } };
      }).electron.ipcRenderer;
      return bridge.invoke('world:evaluationStatus', { world });
    }, world);
    const empty = { outcome: 'available', world, configured: false, commitId: null };
    const configured = { outcome: 'available', world, configured: true, commitId };
    if (!isDeepStrictEqual(value, empty) && !isDeepStrictEqual(value, configured)) {
      this.phase = 'stopped';
      throw new Error(`Evaluation status is unavailable or not the exact original World/commit ${commitId}; no retry or replacement`);
    }
    return value as Status;
  }
}
