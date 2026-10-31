import i18n from '@/i18n';
import { validateAppComposeRequest, type AppComposeRequest, type AppComposeSource } from '@/types/desktop/app-plugin-sdk';
import { sessionIdentitiesEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import { selectChatSelection } from './chat-session';
import { useChatStore } from './store';

export const CHAT_COMPOSER_STAGE_EVENT = 'chat:stage-composer';

export interface ComposerStageRequest {
  identity: SessionIdentity;
  draftKey: string;
  request: AppComposeRequest;
  source: AppComposeSource;
  signal: AbortSignal;
  accept(operation: () => Promise<void>): void;
}

export async function stageComposerPrompt(identity: SessionIdentity, request: AppComposeRequest, source: AppComposeSource, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const error = validateAppComposeRequest(request);
  if (error) throw new Error(i18n.t(error));
  const selection = selectChatSelection(useChatStore.getState());
  const draftKey = selection.currentComposerDraftKey;
  const isCurrent = (current: ReturnType<typeof selectChatSelection>) => Boolean(draftKey
    && current.currentComposerDraftKey === draftKey && current.currentWorkspaceIdentity
    && sessionIdentitiesEqual(identity, current.currentWorkspaceIdentity));
  if (!isCurrent(selection)) throw new Error(i18n.t('chat:input.composeSessionChanged'));
  const scope = new AbortController();
  const unsubscribe = useChatStore.subscribe((state) => {
    if (!isCurrent(selectChatSelection(state))) scope.abort(new Error(i18n.t('chat:input.composeSessionChanged')));
  });
  const operationSignal = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal;
  let operation: (() => Promise<void>) | undefined;
  let receivers = 0;
  try {
    window.dispatchEvent(new CustomEvent<ComposerStageRequest>(CHAT_COMPOSER_STAGE_EVENT, {
      detail: { identity, draftKey, request, source, signal: operationSignal, accept: (candidate) => {
        receivers += 1;
        operation = candidate;
      } },
    }));
    if (receivers === 0 || !operation) throw new Error(i18n.t('chat:input.composeUnavailable'));
    if (receivers !== 1) throw new Error(i18n.t('chat:input.composeReceiverConflict'));
    operationSignal.throwIfAborted();
    await operation();
  } finally {
    unsubscribe();
  }
}
