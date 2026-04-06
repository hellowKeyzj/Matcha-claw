import net from 'node:net';
import { logger } from '../utils/logger';

export async function probeGatewayPortReady(port: number, timeoutMs = 1200): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const resolveOnce = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };

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
}): Promise<void> {
  const retries = options.retries ?? 2400;
  const intervalMs = options.intervalMs ?? 200;
  const waitStartedAt = Date.now();

  for (let i = 0; i < retries; i++) {
    const exitCode = options.getProcessExitCode();
    if (exitCode !== null) {
      logger.error(`Gateway process exited before ready (code=${exitCode})`);
      throw new Error(`Gateway process exited before becoming ready (code=${exitCode})`);
    }

    const ready = await probeGatewayPortReady(options.port);
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

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  logger.error(`Gateway port failed to become ready after ${retries} attempts on port ${options.port}`);
  throw new Error(`Gateway failed to start after ${retries} retries (port ${options.port})`);
}
