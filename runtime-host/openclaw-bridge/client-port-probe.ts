import { GATEWAY_CONNECT_TIMEOUT_MS } from '../shared/runtime-host-constants';
import type { RuntimeTcpProbePort } from '../application/common/runtime-ports';

export async function probeGatewayPortReachable(
  tcpProbe: RuntimeTcpProbePort,
  port: number,
  timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  return await tcpProbe.isReachable('127.0.0.1', port, timeoutMs);
}
