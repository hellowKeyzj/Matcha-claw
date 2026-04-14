export type ChatScrollMode = 'opening' | 'sticky' | 'detached';

export const USER_SCROLL_INTENT_MAX_AGE_MS = 300;

export type ChatScrollCommand =
  | {
    type: 'none';
    targetRowKey: null;
    targetRowCount: 0;
  }
  | {
    type: 'open-to-latest' | 'follow-append' | 'follow-resize';
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
  userScrollIntentAtMs: number | null;
  programmaticScrollInFlight: boolean;
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
    type: 'CONTENT_RESIZED';
  }
  | {
    type: 'VIEWPORT_READY_CHANGED';
    ready: boolean;
  }
  | {
    type: 'VIEWPORT_POSITION_CHANGED';
    isNearBottom: boolean;
    atMs: number;
  }
  | {
    type: 'USER_SCROLL_INTENT';
    atMs: number;
  }
  | {
    type: 'COMMAND_EXECUTION_STARTED';
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
  type: 'open-to-latest' | 'follow-append' | 'follow-resize',
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
    userScrollIntentAtMs: null,
    programmaticScrollInFlight: false,
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
        userScrollIntentAtMs: null,
        programmaticScrollInFlight: false,
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
          programmaticScrollInFlight: false,
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

    case 'CONTENT_RESIZED': {
      if (state.mode !== 'sticky') {
        return state;
      }
      if (state.command.type !== 'none') {
        return state;
      }
      if (state.rowCount <= 0 || state.lastRowKey == null) {
        return state;
      }
      return {
        ...state,
        command: createCommand('follow-resize', state.lastRowKey, state.rowCount),
      };
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
        const hasFreshUserScrollIntent = state.userScrollIntentAtMs != null
          && (event.atMs - state.userScrollIntentAtMs) <= USER_SCROLL_INTENT_MAX_AGE_MS;
        if (hasFreshUserScrollIntent && !state.programmaticScrollInFlight) {
          return {
            ...state,
            mode: 'detached',
            command: createNoneCommand(),
            isNearBottom: false,
            userScrollIntentAtMs: null,
            programmaticScrollInFlight: false,
          };
        }
        const hasStaleUserScrollIntent = state.userScrollIntentAtMs != null && !hasFreshUserScrollIntent;
        if (!state.isNearBottom && !hasStaleUserScrollIntent) {
          return state;
        }
        return {
          ...state,
          isNearBottom: false,
          ...(hasStaleUserScrollIntent
            ? { userScrollIntentAtMs: null }
            : {}),
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
        userScrollIntentAtMs: null,
      };
    }

    case 'USER_SCROLL_INTENT': {
      if (state.userScrollIntentAtMs === event.atMs) {
        return state;
      }
      return {
        ...state,
        userScrollIntentAtMs: event.atMs,
      };
    }

    case 'COMMAND_EXECUTION_STARTED': {
      if (state.command.type === 'none') {
        return state;
      }
      if (state.programmaticScrollInFlight) {
        return state;
      }
      return {
        ...state,
        programmaticScrollInFlight: true,
      };
    }

    case 'BOTTOM_REACHED': {
      return {
        ...state,
        mode: 'sticky',
        command: createNoneCommand(),
        isNearBottom: true,
        userScrollIntentAtMs: null,
        programmaticScrollInFlight: false,
      };
    }

    default:
      return state;
  }
}
