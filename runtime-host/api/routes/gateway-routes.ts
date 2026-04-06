import type { OpenClawBridge } from '../../openclaw-bridge';
import { GatewayService } from '../../application/gateway/service';

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface GatewayRouteDeps {
  openclawBridge: Pick<OpenClawBridge, 'chatSend' | 'gatewayRpc'>;
}

export async function handleGatewayRoute(
  method: string,
  routePath: string,
  payload: unknown,
  deps: GatewayRouteDeps,
): Promise<LocalDispatchResponse | null> {
  const service = new GatewayService({
    openclawBridge: deps.openclawBridge,
  });

  if (method === 'POST' && routePath === '/api/gateway/rpc') {
    return await service.rpc(payload);
  }

  if (!(method === 'POST' && routePath === '/api/chat/send-with-media')) {
    return null;
  }

  return await service.sendMedia(payload);
}
