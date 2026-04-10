export const SUPERVISED_SYSTEMD_ENV_KEYS = [
  'OPENCLAW_SYSTEMD_UNIT',
  'INVOCATION_ID',
  'SYSTEMD_EXEC_PID',
  'JOURNAL_STREAM',
] as const;

export type GatewayEnv = Record<string, string | undefined>;

/**
 * OpenClaw 在发现 systemd 监督环境变量时会进入 supervised 逻辑。
 * 对于由 MatchaClaw 主进程直接托管的 Gateway 子进程，这些变量属于噪声，
 * 需要在 fork 前剥离，避免被误判进入重试循环。
 */
export function stripSystemdSupervisorEnv(env: GatewayEnv): GatewayEnv {
  const next = { ...env };
  for (const key of SUPERVISED_SYSTEMD_ENV_KEYS) {
    delete next[key];
  }
  return next;
}
