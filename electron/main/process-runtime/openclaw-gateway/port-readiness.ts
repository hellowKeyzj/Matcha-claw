import net from 'node:net';
import { logger } from '../../../utils/logger';

export async function probeGatewayPortReady(
  port: number,
  timeoutMs = 1200,
  signal?: AbortSignal,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const resolveOnce = (ready: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    const abort = () => resolveOnce(false);

    if (signal?.aborted) {
      resolveOnce(false);
      return;
    }

    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      resolveOnce(true);
    });
    socket.once('timeout', () => {
      resolveOnce(false);
    });
    socket.once('error', () => {
      resolveOnce(false);
    });
    socket.once('close', () => {
      resolveOnce(false);
    });

    socket.connect(port, '127.0.0.1');
  });
}

export async function waitForGatewayPortReady(options: {
  port: number;
  getProcessExitCode: () => number | null;
  retries?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const retries = options.retries ?? 2400;
  const intervalMs = options.intervalMs ?? 200;
  const waitStartedAt = Date.now();

  for (let i = 0; i < retries; i++) {
    if (options.signal?.aborted) {
      throw new Error('Gateway port readiness aborted');
    }
    const exitCode = options.getProcessExitCode();
    if (exitCode !== null) {
      logger.error(`Gateway process exited before ready (code=${exitCode})`);
      throw new Error(`Gateway process exited before becoming ready (code=${exitCode})`);
    }

    const ready = await probeGatewayPortReady(options.port, 1200, options.signal);
    if (ready) {
      logger.debug(
        `Gateway port ready after ${i + 1} attempt(s), elapsedMs=${Date.now() - waitStartedAt}`,
      );
      return;
    }

    if (i > 0 && i % 10 === 0) {
      logger.debug(
        `Still waiting for Gateway port... (attempt ${i + 1}/${retries}, elapsedMs=${Date.now() - waitStartedAt})`,
      );
    }

    await sleep(intervalMs, options.signal);
  }

  logger.error(`Gateway port failed to become ready after ${retries} attempts on port ${options.port}`);
  throw new Error(`Gateway failed to start after ${retries} retries (port ${options.port})`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
