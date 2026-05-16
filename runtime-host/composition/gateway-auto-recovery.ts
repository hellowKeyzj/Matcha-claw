/**
 * Gateway Auto-Recovery
 *
 * Gateway 内部状态脏了时（如 model capabilities 缓存残缺），会产生 JavaScript TypeError，
 * 表现为 "Cannot read properties of undefined/null (reading 'xxx')" 格式的错误。
 * 这类错误用户无法通过改配置解决，只有重启 Gateway 才能恢复。
 *
 * 本模块在检测到同一 session 连续 N 次收到此类错误时，自动触发一次 Gateway 重启。
 * 每个 Gateway 生命周期内最多自动重启一次，避免无限循环。
 */

import type { RuntimeHostLogger } from '../shared/logger';
import type { SessionUpdateEvent } from '../shared/session-adapter-types';

const CONSECUTIVE_THRESHOLD = 3;

/**
 * 判断错误是否属于 Gateway 内部 TypeError。
 * 正常的 provider 错误（key 无效、余额不足、超时等）不会产生此格式。
 */
function isRecoverableInternalError(error: string): boolean {
  return error.startsWith('Cannot read properties of');
}

export interface GatewayAutoRecoveryDeps {
  requestRestart: (reason: string) => Promise<void>;
  logger?: RuntimeHostLogger;
}

export class GatewayAutoRecovery {
  private readonly counts = new Map<string, { error: string; count: number }>();
  private attempted = false;
  private pending = false;

  constructor(private readonly deps: GatewayAutoRecoveryDeps) {}

  /**
   * 喂入一个 session update event。内部判断是否需要触发自动重启。
   */
  observe(event: SessionUpdateEvent): void {
    if (event.sessionUpdate !== 'session_info_update' || event.phase !== 'error') {
      return;
    }
    const error = event.error;
    const sessionKey = event.sessionKey ?? '';

    if (!error || !isRecoverableInternalError(error)) {
      this.counts.delete(sessionKey);
      return;
    }

    if (this.attempted || this.pending) {
      return;
    }

    const entry = this.counts.get(sessionKey);
    if (entry && entry.error === error) {
      entry.count += 1;
    } else {
      this.counts.set(sessionKey, { error, count: 1 });
    }

    if (this.counts.get(sessionKey)!.count >= CONSECUTIVE_THRESHOLD) {
      this.restart(error);
    }
  }

  /** Gateway 重新连接后调用，重置连续计数。 */
  reset(): void {
    this.counts.clear();
  }

  private restart(error: string): void {
    this.pending = true;
    this.deps.logger?.warn(
      `[gateway-auto-recovery] auto-restarting gateway after ${CONSECUTIVE_THRESHOLD} consecutive internal errors: ${error}`,
    );
    void this.deps.requestRestart('auto-recovery-internal-type-error')
      .catch(() => undefined)
      .finally(() => {
        this.attempted = true;
        this.pending = false;
        this.counts.clear();
      });
  }
}
