const CHAT_SCROLL_DRAIN_IDLE_MS = 160;

let chatScrollDraining = false;
let chatScrollDrainTimer: number | null = null;

export function markChatScrollActivity(): void {
  chatScrollDraining = true;
  if (chatScrollDrainTimer != null && typeof window !== 'undefined') {
    window.clearTimeout(chatScrollDrainTimer);
  }
  if (typeof window === 'undefined') {
    chatScrollDrainTimer = null;
    return;
  }
  chatScrollDrainTimer = window.setTimeout(() => {
    chatScrollDraining = false;
    chatScrollDrainTimer = null;
  }, CHAT_SCROLL_DRAIN_IDLE_MS);
}

export function getIsChatScrollDraining(): boolean {
  return chatScrollDraining;
}
