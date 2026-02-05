/**
 * OpenClaw Auth Profiles Utility
 * Writes API keys to ~/.openclaw/agents/main/agent/auth-profiles.json
 * so the OpenClaw Gateway can load them for AI provider calls.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const AUTH_STORE_VERSION = 1;
const AUTH_PROFILE_FILENAME = 'auth-profiles.json';

/**
 * Auth profile entry for an API key
 */
interface AuthProfileEntry {
  type: 'api_key';
  provider: string;
  key: string;
}

/**
 * Auth profiles store format
 */
interface AuthProfilesStore {
  version: number;
  profiles: Record<string, AuthProfileEntry>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
}

/**
 * Provider type to environment variable name mapping
 */
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

/**
 * Get the path to the auth-profiles.json for a given agent
 */
function getAuthProfilesPath(agentId = 'main'): string {
  return join(homedir(), '.openclaw', 'agents', agentId, 'agent', AUTH_PROFILE_FILENAME);
}

/**
 * Read existing auth profiles store, or create an empty one
 */
function readAuthProfiles(agentId = 'main'): AuthProfilesStore {
  const filePath = getAuthProfilesPath(agentId);
  
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as AuthProfilesStore;
      // Validate basic structure
      if (data.version && data.profiles && typeof data.profiles === 'object') {
        return data;
      }
    }
  } catch (error) {
    console.warn('Failed to read auth-profiles.json, creating fresh store:', error);
  }
  
  return {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
}

/**
 * Write auth profiles store to disk
 */
function writeAuthProfiles(store: AuthProfilesStore, agentId = 'main'): void {
  const filePath = getAuthProfilesPath(agentId);
  const dir = join(filePath, '..');
  
  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Save a provider API key to OpenClaw's auth-profiles.json
 * This writes the key in the format OpenClaw expects so the gateway
 * can use it for AI provider calls.
 * 
 * @param provider - Provider type (e.g., 'anthropic', 'openrouter', 'openai', 'google')
 * @param apiKey - The API key to store
 * @param agentId - Agent ID (defaults to 'main')
 */
export function saveProviderKeyToOpenClaw(
  provider: string,
  apiKey: string,
  agentId = 'main'
): void {
  const store = readAuthProfiles(agentId);
  
  // Profile ID follows OpenClaw convention: <provider>:default
  const profileId = `${provider}:default`;
  
  // Upsert the profile entry
  store.profiles[profileId] = {
    type: 'api_key',
    provider,
    key: apiKey,
  };
  
  // Update order to include this profile
  if (!store.order) {
    store.order = {};
  }
  if (!store.order[provider]) {
    store.order[provider] = [];
  }
  if (!store.order[provider].includes(profileId)) {
    store.order[provider].push(profileId);
  }
  
  // Set as last good
  if (!store.lastGood) {
    store.lastGood = {};
  }
  store.lastGood[provider] = profileId;
  
  writeAuthProfiles(store, agentId);
  console.log(`Saved API key for provider "${provider}" to OpenClaw auth-profiles (agent: ${agentId})`);
}

/**
 * Get the environment variable name for a provider type
 */
export function getProviderEnvVar(provider: string): string | undefined {
  return PROVIDER_ENV_VARS[provider];
}

/**
 * Build environment variables object with all stored API keys
 * for passing to the Gateway process
 */
export function buildProviderEnvVars(providers: Array<{ type: string; apiKey: string }>): Record<string, string> {
  const env: Record<string, string> = {};
  
  for (const { type, apiKey } of providers) {
    const envVar = PROVIDER_ENV_VARS[type];
    if (envVar && apiKey) {
      env[envVar] = apiKey;
    }
  }
  
  return env;
}

/**
 * Provider type to default model mapping
 * Used to set the gateway's default model when the user selects a provider
 */
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'anthropic/claude-opus-4-6',
  openai: 'openai/gpt-5.2',
  google: 'google/gemini-3-pro-preview',
  openrouter: 'openrouter/anthropic/claude-opus-4.6',
};

/**
 * Update the OpenClaw config to use the given provider and model
 * Writes to ~/.openclaw/openclaw.json
 */
export function setOpenClawDefaultModel(provider: string): void {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');
  
  let config: Record<string, unknown> = {};
  
  try {
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch (err) {
    console.warn('Failed to read openclaw.json, creating fresh config:', err);
  }
  
  const model = PROVIDER_DEFAULT_MODELS[provider];
  if (!model) {
    console.warn(`No default model mapping for provider "${provider}"`);
    return;
  }
  
  // Set the default model for the agents
  // model must be an object: { primary: "provider/model", fallbacks?: [] }
  const agents = (config.agents || {}) as Record<string, unknown>;
  const defaults = (agents.defaults || {}) as Record<string, unknown>;
  defaults.model = { primary: model };
  agents.defaults = defaults;
  config.agents = agents;
  
  // Ensure gateway mode is set
  const gateway = (config.gateway || {}) as Record<string, unknown>;
  if (!gateway.mode) {
    gateway.mode = 'local';
  }
  config.gateway = gateway;
  
  // Ensure directory exists
  const dir = join(configPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`Set OpenClaw default model to "${model}" for provider "${provider}"`);
}
