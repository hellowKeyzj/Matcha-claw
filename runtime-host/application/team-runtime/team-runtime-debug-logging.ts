const TEAM_RUNTIME_DEBUG_ENV = 'MATCHACLAW_TEAM_RUNTIME_DEBUG';
const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on', 'debug']);

export function isTeamRuntimeDebugLoggingEnabled(): boolean {
  const value = process.env[TEAM_RUNTIME_DEBUG_ENV];
  return typeof value === 'string' && ENABLED_VALUES.has(value.trim().toLowerCase());
}
