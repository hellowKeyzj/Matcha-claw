import type { GatewayRpcPort } from '../gateway/gateway-runtime-port';
import { SessionRuntimeStateStore } from './session-runtime-state';

/**
 * 把会话的 verboseLevel 写为 'full'。
 *
 * Matcha-claw 期望实时事件中携带完整的 tool result 字段，OpenClaw Gateway 仅在
 * verboseLevel='full' 时不裁剪 `agent stream='tool'` 事件 data 里的 result/partialResult。
 * 因此每个会话首次进入活跃使用前，都需要把这个开关打到 full。
 *
 * 通过 stateStore 内存标记去重，进程内对同一 sessionKey 只会触发一次 RPC。
 * RPC 失败不抛错，下一次进入会话时会自动重试。
 */
export async function ensureSessionVerboseFull(
  sessionKey: string,
  gateway: Pick<GatewayRpcPort, 'gatewayRpc'>,
  stateStore: Pick<SessionRuntimeStateStore, 'hasVerboseConfigured' | 'markVerboseConfigured'>,
): Promise<void> {
  if (!sessionKey || stateStore.hasVerboseConfigured(sessionKey)) {
    return;
  }
  try {
    await gateway.gatewayRpc(
      'sessions.patch',
      { key: sessionKey, verboseLevel: 'full' },
      10_000,
    );
    stateStore.markVerboseConfigured(sessionKey);
  } catch {
    // 失败时不标记，下次进入会话再尝试。
  }
}
