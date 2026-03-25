export type ChatScrollMode = 'opening' | 'sticky' | 'detached';

export type ChatScrollCommand =
  | {
    type: 'none';
    targetRowKey: null;
    targetRowCount: 0;
  }
  | {
    type: 'open-to-latest' | 'follow-append';
    targetRowKey: string;
    targetRowCount: number;
  };

export interface ChatScrollState {
  sessionKey: string;
  mode: ChatScrollMode;
  command: ChatScrollCommand;
  lastRowKey: string | null;
  rowCount: number;
  viewportReady: boolean;
  isNearBottom: boolean;
}

export type ChatScrollEvent =
  | {
    type: 'SESSION_SWITCHED';
    sessionKey: string;
    lastRowKey: string | null;
    rowCount: number;
  }
  | {
    type: 'ROWS_CHANGED';
    lastRowKey: string | null;
    rowCount: number;
  }
  | {
    type: 'VIEWPORT_READY_CHANGED';
    ready: boolean;
  }
  | {
    type: 'VIEWPORT_POSITION_CHANGED';
    isNearBottom: boolean;
  }
  | {
    type: 'USER_DETACHED';
  }
  | {
    type: 'BOTTOM_REACHED';
  };

interface CreateInitialChatScrollStateInput {
  sessionKey: string;
  lastRowKey: string | null;
  rowCount: number;
}

function createNoneCommand(): ChatScrollCommand {
  return {
    type: 'none',
    targetRowKey: null,
    targetRowCount: 0,
  };
}

function createCommand(
  type: 'open-to-latest' | 'follow-append',
  lastRowKey: string | null,
  rowCount: number,
): ChatScrollCommand {
  if (!lastRowKey || rowCount <= 0) {
    return createNoneCommand();
  }
  return {
    type,
    targetRowKey: lastRowKey,
    targetRowCount: rowCount,
  };
}

export function createInitialChatScrollState({
  sessionKey,
  lastRowKey,
  rowCount,
}: CreateInitialChatScrollStateInput): ChatScrollState {
  return {
    sessionKey,
    mode: rowCount > 0 ? 'opening' : 'sticky',
    command: rowCount > 0 ? createCommand('open-to-latest', lastRowKey, rowCount) : createNoneCommand(),
    lastRowKey,
    rowCount,
    viewportReady: false,
    isNearBottom: false,
  };
}

export function shouldExecuteChatScrollCommand(state: ChatScrollState): boolean {
  return state.viewportReady
    && state.command.type !== 'none'
    && state.command.targetRowCount > 0
    && state.lastRowKey != null;
}

export function reduceChatScrollState(
  state: ChatScrollState,
  event: ChatScrollEvent,
): ChatScrollState {
  switch (event.type) {
    case 'SESSION_SWITCHED': {
      return {
        ...state,
        sessionKey: event.sessionKey,
        mode: event.rowCount > 0 ? 'opening' : 'sticky',
        command: event.rowCount > 0
          ? createCommand('open-to-latest', event.lastRowKey, event.rowCount)
          : createNoneCommand(),
        lastRowKey: event.lastRowKey,
        rowCount: event.rowCount,
        isNearBottom: false,
      };
    }

    case 'ROWS_CHANGED': {
      const sameRows = state.lastRowKey === event.lastRowKey && state.rowCount === event.rowCount;
      if (sameRows) {
        return state;
      }

      const nextBase: ChatScrollState = {
        ...state,
        lastRowKey: event.lastRowKey,
        rowCount: event.rowCount,
      };

      if (event.rowCount <= 0 || event.lastRowKey == null) {
        return {
          ...nextBase,
          command: createNoneCommand(),
        };
      }

      if (state.command.type !== 'none') {
        return {
          ...nextBase,
          command: createCommand(state.command.type, event.lastRowKey, event.rowCount),
        };
      }

      if (state.mode === 'opening') {
        return {
          ...nextBase,
          command: createCommand('open-to-latest', event.lastRowKey, event.rowCount),
        };
      }

      if (state.mode === 'sticky') {
        return {
          ...nextBase,
          command: createCommand('follow-append', event.lastRowKey, event.rowCount),
        };
      }

      return nextBase;
    }

    case 'VIEWPORT_READY_CHANGED': {
      if (state.viewportReady === event.ready) {
        return state;
      }
      return {
        ...state,
        viewportReady: event.ready,
      };
    }

    case 'VIEWPORT_POSITION_CHANGED': {
      if (!event.isNearBottom) {
        if (!state.isNearBottom) {
          return state;
        }
        return {
          ...state,
          isNearBottom: false,
        };
      }

      if (state.command.type !== 'none') {
        return {
          ...state,
          isNearBottom: true,
        };
      }

      if (state.mode === 'detached') {
        return {
          ...state,
          mode: 'sticky',
          isNearBottom: true,
        };
      }

      if (state.isNearBottom) {
        return state;
      }

      return {
        ...state,
        isNearBottom: true,
      };
    }

    case 'USER_DETACHED': {
      if (state.mode === 'detached' && state.command.type === 'none' && !state.isNearBottom) {
        return state;
      }
      return {
        ...state,
        mode: 'detached',
        command: createNoneCommand(),
        isNearBottom: false,
      };
    }

    case 'BOTTOM_REACHED': {
      return {
        ...state,
        mode: 'sticky',
        command: createNoneCommand(),
        isNearBottom: true,
      };
    }

    default:
      return state;
  }
}
