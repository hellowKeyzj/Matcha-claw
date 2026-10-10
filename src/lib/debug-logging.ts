import { traceLog } from './trace-logger';

export function logRendererDebug(stage: string, payload: () => unknown): void {
  traceLog(() => [stage, payload()]);
}

export function logRendererMatchaTerminalDelivery(stage: string, payload: () => object): void {
  traceLog(() => [`[matcha-terminal-delivery] ${stage}`, payload()]);
}
