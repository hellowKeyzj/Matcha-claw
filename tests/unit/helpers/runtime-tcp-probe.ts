import net from 'node:net';
import type { RuntimeTcpProbePort } from '../../../runtime-host/application/common/runtime-ports';

export class TestRuntimeTcpProbe implements RuntimeTcpProbePort {
  async isReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const resolveOnce = (reachable: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(reachable);
      };

      socket.setTimeout(Math.max(250, timeoutMs));
      socket.once('connect', () => resolveOnce(true));
      socket.once('timeout', () => resolveOnce(false));
      socket.once('error', () => resolveOnce(false));
      socket.once('close', () => resolveOnce(false));
      socket.connect(port, host);
    });
  }
}

export function createTestRuntimeTcpProbe(): RuntimeTcpProbePort {
  return new TestRuntimeTcpProbe();
}
