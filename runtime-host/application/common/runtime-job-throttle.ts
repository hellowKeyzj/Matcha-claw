/**
 * 后台快照刷新类 job 的去重冷却窗口（毫秒）。
 *
 * 这类 job 由前端轮询路由（GET /api/skills/status、/api/cron/jobs 等）触发，
 * 用 dedupeCooldownMs 确保同一 dedupeKey 在窗口内最多入队一次，避免 jobs Map 在
 * 长跑场景下因高频轮询而无界增长。命中冷却时直接返回最近一次完成的 job 快照，
 * 不再创建新 record。
 */
export const RUNTIME_REFRESH_JOB_COOLDOWN_MS = 10_000;
