import type { SessionRenderItem } from '../../types/session/render-item';
import { getSessionTextModel, type SessionTextModel } from './session-presentation';
import { isControlledSessionRenderItem } from './session-render-projection';
import { buildSessionItemReconciliationSignature } from './session-render-signature';

export { buildItemRenderFingerprint } from './session-render-signature';

export function isPendingUserItem(item: SessionRenderItem): boolean {
  return item.kind === 'user-message' && (item.status === 'pending' || item.status === 'sending');
}

function isAuthoritativeUserItem(item: SessionRenderItem): boolean {
  return item.kind === 'user-message' && !isPendingUserItem(item);
}

function buildUserConfirmationKeys(item: SessionRenderItem): string[] {
  if (item.kind !== 'user-message') {
    return [];
  }
  const keys: string[] = [];
  const clientId = item.clientId?.trim();
  if (clientId) {
    keys.push(`client:${clientId}`);
  }
  const messageId = item.messageId?.trim();
  if (messageId) {
    keys.push(`message:${messageId}`);
  }
  return keys;
}

function addStableUserKeys(keys: Set<string>, item: SessionRenderItem): void {
  if (item.kind !== 'user-message') {
    return;
  }
  keys.add(`key:${item.key}`);
  for (const confirmationKey of buildUserConfirmationKeys(item)) {
    keys.add(confirmationKey);
  }
}

function hasStableUserKey(keys: Set<string>, item: SessionRenderItem): boolean {
  if (item.kind !== 'user-message') {
    return false;
  }
  if (keys.has(`key:${item.key}`)) {
    return true;
  }
  return buildUserConfirmationKeys(item).some((confirmationKey) => keys.has(confirmationKey));
}

type UserConfirmationState = {
  authoritativeConfirmationKeys: Set<string>;
  newAuthoritativeUsers: SessionRenderItem[];
  newAuthoritativeIndexesByConfirmationKey: Map<string, number>;
  consumedNewAuthoritativeIndexes: Set<number>;
  nextSequentialNewAuthoritativeIndex: number;
};

function createUserConfirmationState(
  currentItems: SessionRenderItem[],
  nextItems: SessionRenderItem[],
): UserConfirmationState {
  const currentAuthoritativeUserKeys = new Set<string>();
  for (const item of currentItems) {
    if (isAuthoritativeUserItem(item)) {
      addStableUserKeys(currentAuthoritativeUserKeys, item);
    }
  }

  const authoritativeConfirmationKeys = new Set<string>();
  const newAuthoritativeUsers: SessionRenderItem[] = [];
  const newAuthoritativeIndexesByConfirmationKey = new Map<string, number>();
  for (const item of nextItems) {
    if (!isAuthoritativeUserItem(item)) {
      continue;
    }
    const confirmationKeys = buildUserConfirmationKeys(item);
    for (const confirmationKey of confirmationKeys) {
      authoritativeConfirmationKeys.add(confirmationKey);
    }
    if (hasStableUserKey(currentAuthoritativeUserKeys, item)) {
      continue;
    }
    const newAuthoritativeIndex = newAuthoritativeUsers.length;
    newAuthoritativeUsers.push(item);
    for (const confirmationKey of confirmationKeys) {
      newAuthoritativeIndexesByConfirmationKey.set(confirmationKey, newAuthoritativeIndex);
    }
  }

  return {
    authoritativeConfirmationKeys,
    newAuthoritativeUsers,
    newAuthoritativeIndexesByConfirmationKey,
    consumedNewAuthoritativeIndexes: new Set<number>(),
    nextSequentialNewAuthoritativeIndex: 0,
  };
}

function userTextMatches(
  left: SessionRenderItem,
  right: SessionRenderItem,
  normalizeUserText: SessionTextModel['user'],
): boolean {
  if (left.kind !== 'user-message' || right.kind !== 'user-message') {
    return false;
  }
  const leftText = normalizeUserText(left.text).trim();
  return leftText.length > 0 && leftText === normalizeUserText(right.text).trim();
}

function isUserConfirmedByAuthoritativeItems(
  pending: SessionRenderItem,
  confirmationState: UserConfirmationState,
  normalizeUserText: SessionTextModel['user'],
): boolean {
  if (pending.kind !== 'user-message') {
    return false;
  }
  for (const confirmationKey of buildUserConfirmationKeys(pending)) {
    if (confirmationState.authoritativeConfirmationKeys.has(confirmationKey)) {
      const newAuthoritativeIndex = confirmationState.newAuthoritativeIndexesByConfirmationKey.get(confirmationKey);
      if (newAuthoritativeIndex !== undefined) {
        confirmationState.consumedNewAuthoritativeIndexes.add(newAuthoritativeIndex);
      }
      return true;
    }
  }

  while (confirmationState.consumedNewAuthoritativeIndexes.has(
    confirmationState.nextSequentialNewAuthoritativeIndex,
  )) {
    confirmationState.nextSequentialNewAuthoritativeIndex += 1;
  }
  const authoritative = confirmationState.newAuthoritativeUsers[
    confirmationState.nextSequentialNewAuthoritativeIndex
  ];
  if (!authoritative || !userTextMatches(authoritative, pending, normalizeUserText)) {
    return false;
  }
  confirmationState.consumedNewAuthoritativeIndexes.add(
    confirmationState.nextSequentialNewAuthoritativeIndex,
  );
  confirmationState.nextSequentialNewAuthoritativeIndex += 1;
  return true;
}

function dropReconciledOptimisticItems(
  currentItems: SessionRenderItem[],
  nextItems: SessionRenderItem[],
  normalizeUserText: SessionTextModel['user'],
): SessionRenderItem[] {
  const confirmationState = createUserConfirmationState(currentItems, nextItems);
  const pendingItems = currentItems.filter((item) => (
    isPendingUserItem(item)
      && !isUserConfirmedByAuthoritativeItems(item, confirmationState, normalizeUserText)
  ));
  if (pendingItems.length === 0) {
    return nextItems;
  }
  const pendingItemKeys = new Set(pendingItems.map((item) => item.key));
  const nextByKey = new Map(nextItems.map((item) => [item.key, item] as const));
  const emittedNextKeys = new Set<string>();
  const emittedPendingKeys = new Set<string>();
  const merged: SessionRenderItem[] = [];
  for (const currentItem of currentItems) {
    if (pendingItemKeys.has(currentItem.key)) {
      emittedPendingKeys.add(currentItem.key);
      merged.push(currentItem);
      continue;
    }
    const nextItem = nextByKey.get(currentItem.key);
    if (nextItem) {
      emittedNextKeys.add(nextItem.key);
      merged.push(nextItem);
    }
  }
  for (const pending of pendingItems) {
    if (!emittedPendingKeys.has(pending.key)) {
      merged.push(pending);
    }
  }
  for (const nextItem of nextItems) {
    if (!emittedNextKeys.has(nextItem.key)) {
      merged.push(nextItem);
    }
  }
  return merged;
}

export function reconcileSessionItems(
  currentItems: SessionRenderItem[],
  nextItems: SessionRenderItem[],
  normalizeUserText: SessionTextModel['user'] = getSessionTextModel().user,
): SessionRenderItem[] {
  if (currentItems === nextItems) {
    return currentItems;
  }
  const canonicalNextItems = dropReconciledOptimisticItems(currentItems, nextItems, normalizeUserText);
  if (canonicalNextItems.length === 0) {
    return currentItems.length === 0 ? currentItems : canonicalNextItems;
  }

  const currentByKey = new Map(
    currentItems.map((item) => [item.key, item] as const),
  );
  let changed = currentItems.length !== canonicalNextItems.length || canonicalNextItems.length !== nextItems.length;

  const reconciled = canonicalNextItems.map((nextItem, index) => {
    const currentItem = currentByKey.get(nextItem.key);
    if (!currentItem || currentItem.kind !== nextItem.kind) {
      changed = true;
      return nextItem;
    }
    if (currentItem !== nextItem || !isControlledSessionRenderItem(currentItem)) {
      if (buildSessionItemReconciliationSignature(currentItem) !== buildSessionItemReconciliationSignature(nextItem)) {
        changed = true;
        return nextItem;
      }
    }
    if (currentItems[index] !== currentItem) {
      changed = true;
    }
    return currentItem;
  });
  const receiptConfirmationState = createUserConfirmationState(currentItems, canonicalNextItems);
  const preservedReceipts = currentItems.filter((item) => (
    item.kind === 'user-message'
    && item.rendererReceiptRunId
    && !canonicalNextItems.some((nextItem) => nextItem.key === item.key)
    && !isUserConfirmedByAuthoritativeItems(item, receiptConfirmationState, normalizeUserText)
    && canonicalNextItems.some((nextItem) => (
      (
        nextItem.kind === 'assistant-turn'
        && nextItem.runId === item.rendererReceiptRunId
      )
      || (
        nextItem.kind === 'user-message'
        && !nextItem.runId
        && nextItem.text === item.text
        && nextItem.createdAt === item.createdAt
      )
    ))
  ));
  if (preservedReceipts.length > 0) {
    changed = true;
  }

  return changed ? [...reconciled, ...preservedReceipts] : currentItems;
}
