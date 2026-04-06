/**
 * Application Configuration
 * Centralized configuration constants and helpers
 */

/**
 * Port configuration
 */
export const PORTS = {
  /** ClawX GUI development server port */
  CLAWX_DEV: 5173,

  /** ClawX GUI production port (for reference) */
  CLAWX_GUI: 23333,

  /** Local host API server port */
  MATCHACLAW_HOST_API: 3210,

  /** Runtime host process port */
  MATCHACLAW_RUNTIME_HOST: 3211,

  /** OpenClaw Gateway port */
  OPENCLAW_GATEWAY: 18789,

  // Backward-compatible aliases retained for existing references.
  MatchaClaw_DEV: 5173,
  MatchaClaw_GUI: 23333,
} as const;

type PortKey = keyof typeof PORTS;
type CanonicalPortKey =
  | 'CLAWX_DEV'
  | 'CLAWX_GUI'
  | 'MATCHACLAW_HOST_API'
  | 'MATCHACLAW_RUNTIME_HOST'
  | 'OPENCLAW_GATEWAY';

function toCanonicalPortKey(key: PortKey): CanonicalPortKey {
  if (key === 'MatchaClaw_DEV') return 'CLAWX_DEV';
  if (key === 'MatchaClaw_GUI') return 'CLAWX_GUI';
  return key;
}

function parseEnvPort(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Get port from environment or default
 */
export function getPort(key: PortKey): number {
  const canonical = toCanonicalPortKey(key);
  const envKeys = new Set<string>([
    `MATCHACLAW_PORT_${canonical}`,
    `CLAWX_PORT_${canonical}`,
    `MATCHACLAW_PORT_${key}`,
    `CLAWX_PORT_${key}`,
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
