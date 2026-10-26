import { Ability } from '@serenity-js/core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UseElectron } from './use-electron.ability.js';

const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } as const;
const scope = { kind: 'runtime-instance', endpoint } as const;
const pathCanary = 'e2e-team-private-path-canary';
const contentCanary = 'e2e-team-private-content-canary-not-a-credential';
const invalidRequest = { success: false, error: 'Team runtime request is invalid' } as const;

function boundaryReceipt(
  reply: Awaited<ReturnType<UseElectron['fetchHostApi']>>,
  expected: Record<string, unknown>,
  packageRoot?: string,
) {
  const value = reply.ok ? reply.data.json : undefined;
  const body = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const serialized = JSON.stringify(reply);
  const encodedRoot = packageRoot ? JSON.stringify(packageRoot).slice(1, -1) : undefined;
  return {
    ipcOk: reply.ok,
    status: reply.ok ? reply.data.status : null,
    httpOk: reply.ok && reply.data.ok,
    exactBody: Object.keys(body).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, expectedValue]) => body[key] === expectedValue),
    privatePathExposed: serialized.includes(pathCanary)
      || Boolean(encodedRoot && serialized.includes(encodedRoot)),
    privateContentExposed: serialized.includes(contentCanary),
  };
}

export class UseTeamBoundaries extends Ability {
  private packageRoot?: string;
  private teamNamesBefore?: string[];
  createDialogOpeningAttempted = false;

  constructor(private readonly electron: UseElectron) { super(); }

  async prepareInvalidPackage(): Promise<void> {
    this.packageRoot = await mkdtemp(join(tmpdir(), `${pathCanary}-`));
    await writeFile(join(this.packageRoot, 'SKILL.md'), `Deliberately missing YAML frontmatter.\n${contentCanary}\n`);
    await writeFile(join(this.packageRoot, 'workflow.md'), 'Invalid package validation only; never execute.\n');
    await writeFile(join(this.packageRoot, 'dependencies.yaml'), 'skills: []\ntools: []\n');
  }

  private requirePackageRoot(): string {
    if (!this.packageRoot) throw new Error('Invalid TeamSkill temporary package has not been prepared');
    return this.packageRoot;
  }

  async validateInvalidPackage() {
    const root = this.requirePackageRoot();
    const reply = await this.electron.fetchHostApi({
      path: '/api/capabilities/execute', method: 'POST',
      body: {
        id: 'team.runtime', operationId: 'team.packageValidate', scope,
        target: { kind: 'team', packagePath: root }, input: { packagePath: root },
      },
    });
    return boundaryReceipt(reply, { status: 'invalid' }, root);
  }

  async completeInvalidPackagePicker(): Promise<void> {
    await this.electron.completeNativeDirectoryPicker(this.requirePackageRoot());
  }

  rememberTeamList(names: string[]): void {
    this.teamNamesBefore = [...names].sort();
  }

  isTeamListUnchanged(names: string[]): boolean {
    const before = this.teamNamesBefore;
    if (!before) throw new Error('The original Team collection has not been observed');
    const current = [...names].sort();
    return current.length === before.length && current.every((name, index) => name === before[index]);
  }

  async removeInvalidPackage(): Promise<void> {
    if (!this.packageRoot) return;
    await rm(this.packageRoot, { recursive: true, force: true });
    this.packageRoot = undefined;
  }

  async rejectMismatchedPackageTarget() {
    const reply = await this.electron.fetchHostApi({
      path: '/api/capabilities/execute', method: 'POST',
      body: {
        id: 'team.runtime', operationId: 'team.packageValidate', scope,
        target: { kind: 'team', packagePath: `${pathCanary}-target` },
        input: { packagePath: `${pathCanary}-input`, privateCanary: contentCanary },
      },
    });
    return boundaryReceipt(reply, invalidRequest);
  }

  async rejectAdditionalPackageInput() {
    const reply = await this.electron.fetchHostApi({
      path: '/api/capabilities/execute', method: 'POST',
      body: {
        id: 'team.runtime', operationId: 'team.packageValidate', scope,
        target: { kind: 'team', packagePath: pathCanary },
        input: { packagePath: pathCanary, privateCanary: contentCanary },
      },
    });
    return boundaryReceipt(reply, invalidRequest);
  }
}
