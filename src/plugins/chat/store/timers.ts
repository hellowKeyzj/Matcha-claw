// Module-level timestamp tracking the last chat event received.
// Used by the safety timeout to avoid false-positive "no response" errors
// during tool-use conversations where streamingMessage is temporarily cleared
// between tool-result finals and the next delta.
let lastChatEventAt = 0;

// Timer for fallback history polling during active sends.
// If no streaming events arrive within a few seconds, we periodically
// poll chat.history to surface intermediate tool-call turns.
let historyPollTimer: ReturnType<typeof setTimeout> | null = null;

// Timer for delayed error finalization. When the Gateway reports a mid-stream
// error (e.g. "terminated"), it may retry internally and recover. We wait
// before committing the error to give the recovery path a chance.
let errorRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

// Timer for active-run safety timeout. This stays outside the store so the
// timeout can survive async gaps without becoming store state.
let sendSafetyTimer: ReturnType<typeof setTimeout> | null = null;

export function clearErrorRecoveryTimer(): void {
  if (errorRecoveryTimer) {
    clearTimeout(errorRecoveryTimer);
    errorRecoveryTimer = null;
  }
}

export function clearHistoryPoll(): void {
  if (historyPollTimer) {
    clearTimeout(historyPollTimer);
    historyPollTimer = null;
  }
}

export function setHistoryPollTimer(timer: ReturnType<typeof setTimeout> | null): void {
  historyPollTimer = timer;
}

export function hasErrorRecoveryTimer(): boolean {
  return errorRecoveryTimer != null;
}

export function setErrorRecoveryTimer(timer: ReturnType<typeof setTimeout> | null): void {
  errorRecoveryTimer = timer;
}

export function clearSendSafetyTimer(): void {
  if (sendSafetyTimer) {
    clearTimeout(sendSafetyTimer);
    sendSafetyTimer = null;
  }
}

export function setSendSafetyTimer(timer: ReturnType<typeof setTimeout> | null): void {
  sendSafetyTimer = timer;
}

export function setLastChatEventAt(value: number): void {
  lastChatEventAt = value;
}

export function getLastChatEventAt(): number {
  return lastChatEventAt;
}
