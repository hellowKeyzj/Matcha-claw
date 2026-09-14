/**
 * Application Configuration
 * Centralized configuration constants and helpers
 */

/**
 * Port configuration
 */
export const PORTS = {
  /** MatchaClaw GUI development server port */
  MATCHACLAW_DEV: 5173,

  /** MatchaClaw GUI production port (for reference) */
  MATCHACLAW_GUI: 23333,

  /** Local host API server port */
  MATCHACLAW_HOST_API: 13210,

  /** Runtime host compatibility transport port */
  MATCHACLAW_RUNTIME_HOST: 3211,

  /** Runtime Host session transport port */
  MATCHACLAW_SESSION_TRANSPORT: 3251,

  /** matcha-agent app-server port */
  MATCHA_AGENT_APP_SERVER: 3212,

  /** Runtime Host Fleet transport port */
  MATCHACLAW_FLEET_TRANSPORT: 3248,

  /** Runtime Host channel catalog transport port */
  MATCHACLAW_CHANNEL_CATALOG_TRANSPORT: 3246,

  /** Runtime Host diagnostics transport port */
  MATCHACLAW_DIAGNOSTICS_TRANSPORT: 3213,

  /** Runtime Host workspace text transport port */
  MATCHACLAW_WORKSPACE_TEXT_TRANSPORT: 3214,

  /** Runtime Host workspace directory transport port */
  MATCHACLAW_WORKSPACE_DIRECTORY_TRANSPORT: 3215,

  /** Runtime Host workspace write transport port */
  MATCHACLAW_WORKSPACE_WRITE_TRANSPORT: 3216,

  /** Runtime Host session send transport port */
  MATCHACLAW_SESSION_SEND_TRANSPORT: 3217,

  /** Runtime Host session abort transport port */
  MATCHACLAW_SESSION_ABORT_TRANSPORT: 3218,

  /** Runtime Host Matcha Agent chat history transport port */
  MATCHACLAW_MATCHA_HISTORY_TRANSPORT: 3244,

  /** Runtime Host OpenClaw usage history transport port */
  MATCHACLAW_USAGE_TRANSPORT: 3243,

  /** Runtime Host session model selection transport port */
  MATCHACLAW_SESSION_MODEL_SELECTION_TRANSPORT: 3220,

  /** Runtime Host security emergency transport port */
  MATCHACLAW_SECURITY_EMERGENCY_TRANSPORT: 3221,

  /** Runtime Host channel account status transport port */
  MATCHACLAW_CHANNEL_STATUS_TRANSPORT: 3224,

  /** Runtime Host channel runtime control and configuration delete transport port */
  MATCHACLAW_CHANNEL_CONTROL_TRANSPORT: 3238,

  /** Runtime Host channel pairing-list transport port */
  MATCHACLAW_CHANNEL_PAIRING_TRANSPORT: 3237,

  /** Runtime Host Settings desired-state transport port */
  MATCHACLAW_SETTINGS_DESIRED_TRANSPORT: 32136,

  /** Runtime Host Security policy transport port */
  MATCHACLAW_SECURITY_POLICY_TRANSPORT: 32137,

  /** Runtime Host session approval transport port */
  MATCHACLAW_SESSION_APPROVAL_TRANSPORT: 3222,

  /** Runtime Host OpenClaw subagent management transport port */
  MATCHACLAW_AGENTS_TRANSPORT: 3225,

  /** Runtime Host cron CRUD/list transport port */
  MATCHACLAW_CRON_TRANSPORT: 3226,

  /** Dedicated Runtime Host Cron broker transport port */
  MATCHACLAW_CRON_BROKER_TRANSPORT: 3250,

  /** Runtime Host Task Manager transport port */
  MATCHACLAW_TASK_MANAGER_TRANSPORT: 3245,

  /** Runtime Host fixed Team public projection transport port */
  MATCHACLAW_TEAM_PUBLIC_TRANSPORT: 3227,

  /** Runtime Host fixed Team task board transport port */
  MATCHACLAW_TEAM_TASK_BOARD_TRANSPORT: 3247,

  /** Runtime Host fixed Team role-session projection transport port */
  MATCHACLAW_TEAM_ROLE_SESSIONS_TRANSPORT: 3242,

  /** Runtime Host fixed Team pending approvals transport port */
  MATCHACLAW_TEAM_APPROVALS_TRANSPORT: 3239,

  /** Runtime Host fixed Team human decision transport port */
  MATCHACLAW_TEAM_DECISION_TRANSPORT: 3234,

  /** Runtime Host fixed Team role-chat transport port */
  MATCHACLAW_TEAM_ROLE_CHAT_TRANSPORT: 3236,

  /** Runtime Host provider model catalog transport port */
  MATCHACLAW_PROVIDER_MODELS_TRANSPORT: 3228,

  /** Runtime Host provider account catalog transport port */
  MATCHACLAW_PROVIDER_ACCOUNTS_TRANSPORT: 3240,

  /** Runtime Host fixed Team graph YAML transport port */
  MATCHACLAW_TEAM_GRAPH_TRANSPORT: 3229,

  /** Runtime Host fixed TeamSkill selection transport port */
  MATCHACLAW_TEAM_SKILL_TRANSPORT: 3230,

  /** Runtime Host fixed Team trigger transport port */
  MATCHACLAW_TEAM_TRIGGER_TRANSPORT: 3231,

  /** Runtime Host fixed Team lifecycle transport port */
  MATCHACLAW_TEAM_LIFECYCLE_TRANSPORT: 3233,

  /** Runtime Host fixed Manual Team materialize-and-create transport port */
  MATCHACLAW_MANUAL_TEAM_TRANSPORT: 3235,

  /** Runtime Host workspace binary/stat transport port */
  MATCHACLAW_WORKSPACE_BINARY_TRANSPORT: 3232,

  /** Runtime Host workspace media transport port */
  MATCHACLAW_WORKSPACE_MEDIA_TRANSPORT: 3241,

  /** OpenClaw Gateway port */
  OPENCLAW_GATEWAY: 18789,

  // Backward-compatible aliases retained for existing references.
  MatchaClaw_DEV: 5173,
  MatchaClaw_GUI: 23333,
} as const;

type PortKey = keyof typeof PORTS;
type CanonicalPortKey =
  | 'MATCHACLAW_DEV'
  | 'MATCHACLAW_GUI'
  | 'MATCHACLAW_HOST_API'
  | 'MATCHACLAW_RUNTIME_HOST'
  | 'MATCHACLAW_SESSION_TRANSPORT'
  | 'MATCHA_AGENT_APP_SERVER'
  | 'MATCHACLAW_FLEET_TRANSPORT'
  | 'MATCHACLAW_DIAGNOSTICS_TRANSPORT'
  | 'MATCHACLAW_WORKSPACE_TEXT_TRANSPORT'
  | 'MATCHACLAW_WORKSPACE_BINARY_TRANSPORT'
  | 'MATCHACLAW_WORKSPACE_DIRECTORY_TRANSPORT'
  | 'MATCHACLAW_WORKSPACE_WRITE_TRANSPORT'
  | 'MATCHACLAW_WORKSPACE_MEDIA_TRANSPORT'
  | 'MATCHACLAW_SESSION_SEND_TRANSPORT'
  | 'MATCHACLAW_SESSION_ABORT_TRANSPORT'
  | 'MATCHACLAW_MATCHA_HISTORY_TRANSPORT'
  | 'MATCHACLAW_USAGE_TRANSPORT'
  | 'MATCHACLAW_SESSION_MODEL_SELECTION_TRANSPORT'
  | 'MATCHACLAW_SECURITY_EMERGENCY_TRANSPORT'
  | 'MATCHACLAW_CHANNEL_STATUS_TRANSPORT'
  | 'MATCHACLAW_CHANNEL_CONTROL_TRANSPORT'
  | 'MATCHACLAW_CHANNEL_PAIRING_TRANSPORT'
  | 'MATCHACLAW_SETTINGS_DESIRED_TRANSPORT'
  | 'MATCHACLAW_SECURITY_POLICY_TRANSPORT'
  | 'MATCHACLAW_SESSION_APPROVAL_TRANSPORT'
  | 'MATCHACLAW_AGENTS_TRANSPORT'
  | 'MATCHACLAW_CRON_TRANSPORT'
  | 'MATCHACLAW_CRON_BROKER_TRANSPORT'
  | 'MATCHACLAW_TASK_MANAGER_TRANSPORT'
  | 'MATCHACLAW_CHANNEL_CATALOG_TRANSPORT'
  | 'MATCHACLAW_TEAM_PUBLIC_TRANSPORT'
  | 'MATCHACLAW_TEAM_TASK_BOARD_TRANSPORT'
  | 'MATCHACLAW_TEAM_ROLE_SESSIONS_TRANSPORT'
  | 'MATCHACLAW_TEAM_APPROVALS_TRANSPORT'
  | 'MATCHACLAW_TEAM_DECISION_TRANSPORT'
  | 'MATCHACLAW_TEAM_ROLE_CHAT_TRANSPORT'
  | 'MATCHACLAW_PROVIDER_MODELS_TRANSPORT'
  | 'MATCHACLAW_PROVIDER_ACCOUNTS_TRANSPORT'
  | 'MATCHACLAW_TEAM_GRAPH_TRANSPORT'
  | 'MATCHACLAW_TEAM_SKILL_TRANSPORT'
  | 'MATCHACLAW_TEAM_TRIGGER_TRANSPORT'
  | 'MATCHACLAW_TEAM_LIFECYCLE_TRANSPORT'
  | 'MATCHACLAW_MANUAL_TEAM_TRANSPORT'
  | 'OPENCLAW_GATEWAY';

function toCanonicalPortKey(key: PortKey): CanonicalPortKey {
  if (key === 'MatchaClaw_DEV') return 'MATCHACLAW_DEV';
  if (key === 'MatchaClaw_GUI') return 'MATCHACLAW_GUI';
  return key;
}

function parseEnvPort(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) return null;
  return parsed;
}

/**
 * Get port from environment or default
 */
export function getPort(key: PortKey): number {
  const canonical = toCanonicalPortKey(key);
  const envKeys = new Set<string>([
    `MATCHACLAW_PORT_${canonical}`,
    `MATCHACLAW_PORT_${canonical}`,
    `MATCHACLAW_PORT_${key}`,
    `MATCHACLAW_PORT_${key}`,
    `MatchaClaw_PORT_${key}`,
  ]);

  if (canonical === 'MATCHACLAW_HOST_API') {
    envKeys.clear();
    envKeys.add('MATCHACLAW_PORT_MATCHACLAW_HOST_API');
  }
  if (canonical === 'MATCHACLAW_RUNTIME_HOST') {
    envKeys.clear();
    envKeys.add('MATCHACLAW_RUNTIME_HOST_PORT');
  }
  if (canonical === 'MATCHACLAW_SESSION_TRANSPORT') {
    envKeys.clear();
    envKeys.add('MATCHACLAW_SESSION_TRANSPORT_PORT');
  }
  if (canonical === 'MATCHA_AGENT_APP_SERVER') {
    envKeys.clear();
    envKeys.add('MATCHACLAW_MATCHA_AGENT_APP_SERVER_PORT');
  }
  if (
    canonical === 'MATCHACLAW_SETTINGS_DESIRED_TRANSPORT' ||
    canonical === 'MATCHACLAW_SECURITY_POLICY_TRANSPORT' ||
    canonical === 'MATCHACLAW_CHANNEL_CATALOG_TRANSPORT' ||
    canonical === 'MATCHACLAW_CRON_BROKER_TRANSPORT' ||
    canonical === 'MATCHACLAW_TEAM_ROLE_SESSIONS_TRANSPORT' ||
    canonical === 'MATCHACLAW_TEAM_SKILL_TRANSPORT' ||
    canonical === 'MATCHACLAW_TEAM_TRIGGER_TRANSPORT' ||
    canonical === 'MATCHACLAW_TEAM_LIFECYCLE_TRANSPORT' ||
    canonical === 'MATCHACLAW_MANUAL_TEAM_TRANSPORT'
  ) {
    envKeys.clear();
    envKeys.add(canonical);
  }

  for (const envKey of envKeys) {
    const parsed = parseEnvPort(process.env[envKey]);
    if (parsed != null) {
      return parsed;
    }
  }

  return PORTS[key];
}

/**
 * Application paths
 */
export const APP_PATHS = {
  /** OpenClaw configuration directory */
  OPENCLAW_CONFIG: '~/.openclaw',

  /** MatchaClaw configuration directory */
  MatchaClaw_CONFIG: '~/.MatchaClaw',

  /** Log files directory */
  LOGS: '~/.MatchaClaw/logs',
} as const;

/**
 * Update channels
 */
export const UPDATE_CHANNELS = ['stable', 'beta', 'dev'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/**
 * Default update configuration
 */
export const UPDATE_CONFIG = {
  /** Check interval in milliseconds (6 hours) */
  CHECK_INTERVAL: 6 * 60 * 60 * 1000,

  /** Default update channel */
  DEFAULT_CHANNEL: 'stable' as UpdateChannel,

  /** Auto download updates */
  AUTO_DOWNLOAD: false,

  /** Show update notifications */
  SHOW_NOTIFICATION: true,
};

/**
 * Gateway configuration
 */
export const GATEWAY_CONFIG = {
  /** WebSocket reconnection delay (ms) */
  RECONNECT_DELAY: 5000,

  /** RPC call timeout (ms) */
  RPC_TIMEOUT: 30000,

  /** Health check interval (ms) */
  HEALTH_CHECK_INTERVAL: 30000,

  /** Maximum startup retries */
  MAX_STARTUP_RETRIES: 30,

  /** Startup retry interval (ms) */
  STARTUP_RETRY_INTERVAL: 1000,
};
