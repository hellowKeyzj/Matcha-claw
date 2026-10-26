import { notes } from '@serenity-js/core';

type ChangeSetGrantEvidence = {
  phase: string;
  retained: boolean;
  receipt?: { world: { tenantId: string; worldId: string }; commitId: string; committedAt: string; revisions: unknown[]; outboxIds: unknown[]; fence: { world: { tenantId: string; worldId: string }; domain: string; epoch: string } };
  changeSetAccess?: {
    change: { id: string; revision: string; status: string };
    operations: { kind: string; operationId: string }[];
    input: { commitId: string; id: string; actor: { kind: string; id: string }; access: { resources: { kind: string; id: string }[]; modes: string[]; fields: unknown[]; scope: string; validTime: null }[]; labels: string[]; effects: string[]; expiresAt: string };
  };
};

export const OrderChangeSetGrantConfirmed = () => notes<{ worldOrderChangeSetGrant: ChangeSetGrantEvidence }>().get('worldOrderChangeSetGrant').as(evidence => {
  const access = evidence.changeSetAccess; const receipt = evidence.receipt;
  if (!access || !receipt) return false;
  const changeId = 'change-4c6bc4307890146754d99237b4ef7304d35c4e84f49460e9ae6febfc35501532';
  const scope = access.input.access[0];
  return ['confirmed', 'confirmed-original'].includes(evidence.phase) && evidence.retained
    && access.change.id === changeId && access.change.revision === '2' && access.change.status === 'validated'
    && access.operations.length === 2 && access.operations[0].kind === 'propose' && access.operations[1].kind === 'validate'
    && access.operations.every(operation => operation.operationId.length > 0)
    && access.input.actor.kind === 'human' && access.input.actor.id === 'human:personal-desktop'
    && access.input.access.length === 1 && scope.resources.length === 1 && scope.resources[0].kind === 'change_set' && scope.resources[0].id === changeId
    && scope.modes.join(',') === 'read,write' && scope.fields.length === 0 && scope.scope === 'scope:personal:management' && scope.validTime === null
    && access.input.labels.length === 0 && access.input.effects.length === 0 && access.input.expiresAt === '2026-10-28T23:59:59.000000000Z'
    && receipt.commitId === access.input.commitId && receipt.world.tenantId === 'local' && receipt.world.worldId === 'personal'
    && receipt.fence.world.tenantId === 'local' && receipt.fence.world.worldId === 'personal'
    && receipt.fence.domain === 'authorization' && /^[1-9]\d*$/.test(receipt.fence.epoch)
    && receipt.revisions.length === 0 && receipt.outboxIds.length === 0 && Number.isFinite(Date.parse(receipt.committedAt));
});
