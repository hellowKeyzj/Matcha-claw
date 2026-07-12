const RENDERER_DEBUG_LOG_STORAGE_KEY = 'matchaclaw:debug-log';

export function isRendererDebugLoggingEnabled(): boolean {
  try {
    return window.localStorage.getItem(RENDERER_DEBUG_LOG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function logRendererDebug(stage: string, payload: unknown): void {
  if (!isRendererDebugLoggingEnabled()) {
    return;
  }
  console.info(stage, payload);
}

export function logRendererMatchaTerminalDelivery(stage: string, payload: object): void {
  if (!isRendererDebugLoggingEnabled()) {
    return;
  }
  console.info(`[matcha-terminal-delivery] ${stage}`, payload);
}
