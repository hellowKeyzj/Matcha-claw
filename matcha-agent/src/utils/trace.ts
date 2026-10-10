export function isTraceEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MATCHACLAW_TRACE === '1'
}
