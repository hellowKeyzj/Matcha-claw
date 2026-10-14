export function isTraceEnabled(): boolean {
  return typeof window !== 'undefined' && window.electron?.traceEnabled === true;
}

export function traceLog(payload: () => readonly unknown[]): void {
  if (isTraceEnabled()) {
    console.info(...payload());
  }
}

export function startupTrace(source: string, phase: string, detail?: () => Record<string, unknown>): void {
  traceLog(() => [`[startup-trace] ${JSON.stringify({
    source, phase, at: Date.now(), navigationMs: Math.round(performance.now()), ...detail?.(),
  })}`]);
}
