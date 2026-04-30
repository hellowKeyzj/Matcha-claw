export interface ChatScrollChromeSnapshot {
  isBottomLocked: boolean;
  visible: boolean;
  isAtLatest: boolean;
  jumpActionLabel: string;
}

export interface ChatScrollChromeStore {
  getSnapshot: () => ChatScrollChromeSnapshot;
  subscribe: (listener: () => void) => () => void;
  setBottomLocked: (isBottomLocked: boolean) => void;
  setChromeState: (state: Omit<ChatScrollChromeSnapshot, 'isBottomLocked'>) => void;
  setJumpHandlers: (handlers: {
    jumpToBottom: () => void;
    jumpToLatest: () => void;
  }) => void;
  runJumpAction: () => void;
}

const DEFAULT_SNAPSHOT: ChatScrollChromeSnapshot = {
  isBottomLocked: true,
  visible: false,
  isAtLatest: true,
  jumpActionLabel: '',
};

export function createChatScrollChromeStore(
  initialSnapshot: ChatScrollChromeSnapshot = DEFAULT_SNAPSHOT,
): ChatScrollChromeStore {
  let snapshot = initialSnapshot;
  let jumpToBottom = () => {};
  let jumpToLatest = () => {};
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
    setBottomLocked: (isBottomLocked) => {
      if (snapshot.isBottomLocked === isBottomLocked) {
        return;
      }
      snapshot = {
        ...snapshot,
        isBottomLocked,
      };
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
      snapshot = {
        ...snapshot,
        ...state,
      };
      emit();
    },
    setJumpHandlers: (handlers) => {
      jumpToBottom = handlers.jumpToBottom;
      jumpToLatest = handlers.jumpToLatest;
    },
    runJumpAction: () => {
      if (snapshot.isAtLatest) {
        jumpToBottom();
        return;
      }
      jumpToLatest();
    },
  };
}
