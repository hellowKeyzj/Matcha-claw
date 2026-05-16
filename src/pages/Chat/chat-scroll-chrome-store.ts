import type { ChatScrollPhase } from './chat-scroll-model';

export interface ChatScrollChromeSnapshot {
  phase: ChatScrollPhase;
  visible: boolean;
  isAtLatest: boolean;
  jumpActionLabel: string;
}

export interface ChatScrollChromeStore {
  getSnapshot: () => ChatScrollChromeSnapshot;
  subscribe: (listener: () => void) => () => void;
  setPhase: (phase: ChatScrollPhase) => void;
  setChromeState: (state: Omit<ChatScrollChromeSnapshot, 'phase'>) => void;
  setJumpAction: (handler: () => void) => void;
  runJumpAction: () => void;
}

const DEFAULT_SNAPSHOT: ChatScrollChromeSnapshot = {
  phase: 'follow',
  visible: false,
  isAtLatest: true,
  jumpActionLabel: '',
};

export function createChatScrollChromeStore(
  initialSnapshot: ChatScrollChromeSnapshot = DEFAULT_SNAPSHOT,
): ChatScrollChromeStore {
  let snapshot = initialSnapshot;
  let jumpAction: () => void = () => {};
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPhase: (phase) => {
      if (snapshot.phase === phase) {
        return;
      }
      snapshot = { ...snapshot, phase };
      emit();
    },
    setChromeState: (state) => {
      if (
        snapshot.visible === state.visible
        && snapshot.isAtLatest === state.isAtLatest
        && snapshot.jumpActionLabel === state.jumpActionLabel
      ) {
        return;
      }
      snapshot = { ...snapshot, ...state };
      emit();
    },
    setJumpAction: (handler) => {
      jumpAction = handler;
    },
    runJumpAction: () => {
      jumpAction();
    },
  };
}
