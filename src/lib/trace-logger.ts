export function isTraceEnabled(): boolean {
  return typeof window !== 'undefined' && window.electron?.traceEnabled === true;
}

export function traceLog(payload: () => readonly unknown[]): void {
  if (isTraceEnabled()) {
    console.info(...payload());
  }
}
