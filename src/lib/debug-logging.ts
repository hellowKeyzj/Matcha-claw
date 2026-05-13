const RENDERER_DEBUG_LOG_STORAGE_KEY = 'clawx:debug-log';

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
