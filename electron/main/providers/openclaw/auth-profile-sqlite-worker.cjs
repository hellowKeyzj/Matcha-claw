'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { existsSync } = require('node:fs');
const { mkdir } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAX_SECRET_BYTES = 16 * 1024;
const MAX_ID_BYTES = 128;
const MAX_AUTH_PROFILES_BYTES = 1024 * 1024;
const MAX_PROVIDER_KEY_BYTES = 256;
const OPENCLAW_SQLITE_BUSY_TIMEOUT_MS = 5_000;
const OPENCLAW_AUTH_PROFILE_WRITE_RETRY_DELAYS_MS = [50, 100, 200];
const AUTH_SHARED_STORE_STATE_KEY = 'auth.sharedStore';
const AUTH_PROFILES_STORE_STATE_KEY = 'authProfiles.store';
const AUTH_PROFILES_STATE_STATE_KEY = 'authProfiles.state';
const AUTH_SHARED_STORE_STATE_VALUE = { location: 'state-db' };
const path = join(workerData.openClawStateDir, 'state', 'openclaw.sqlite');

class AuthProfileSqliteError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Main sends one closed profile mutation at a time, never SQL or executable text.
// A request remains owned through all busy retries, even if its HTTP observer left.
parentPort.on('message', async (request) => {
  if (request.type === 'close') {
    parentPort.close();
    return;
  }
  try {
    const changed = await writeAuthProfileProjection(request.mutation);
    parentPort.postMessage({ type: 'completed', id: request.id, changed });
  } catch (error) {
    parentPort.postMessage({
      type: 'failed', id: request.id,
      code: error instanceof AuthProfileSqliteError && error.code === 'auth-profile-read-invalid'
        ? error.code : 'auth-profile-write-failed',
    });
  }
});
parentPort.postMessage({ type: 'ready' });

function mutateAuthProfileProjection({ store, state }, mutation) {
  const { profileId, legacyProfileId } = mutation;
  if (mutation.type === 'apply') {
    store.profiles[profileId] = mutation.profile;
    if (legacyProfileId !== profileId) {
      delete store.profiles[legacyProfileId];
      removeProfileReferences(state, legacyProfileId);
    }
    markProfileCurrent(state, mutation.provider, profileId);
  } else {
    delete store.profiles[profileId];
    removeProfileReferences(state, profileId);
    if (legacyProfileId !== profileId) {
      delete store.profiles[legacyProfileId];
      removeProfileReferences(state, legacyProfileId);
    }
  }
}

function markProfileCurrent(state, provider, profileId) {
  state.order ??= {};
  state.order[provider] ??= [];
  if (!state.order[provider].includes(profileId)) {
    state.order[provider].push(profileId);
  }
  state.lastGood ??= {};
  state.lastGood[provider] = profileId;
}

function removeProfileReferences(state, profileId) {
  if (state.order) {
    for (const [provider, profileIds] of Object.entries(state.order)) {
      const next = profileIds.filter((id) => id !== profileId);
      if (next.length > 0) {
        state.order[provider] = next;
      } else {
        delete state.order[provider];
      }
    }
  }
  if (state.lastGood) {
    for (const [provider, currentProfileId] of Object.entries(state.lastGood)) {
      if (currentProfileId === profileId) delete state.lastGood[provider];
    }
  }
}

async function writeAuthProfileProjection(mutation) {
  try {
    if (authProfileProjectionAlreadyMatches(mutation)) return false;
    await mkdir(dirname(path), { recursive: true });
    return await retryAuthProfileSqliteBusy(() => {
      const database = new DatabaseSync(path);
      try {
        database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}`);
        database.exec('BEGIN IMMEDIATE');
        try {
          ensureAuthProfileStateTable(database);
          const projection = readAuthProfileProjection(database);
          const before = authProfileProjectionSnapshot(projection);
          mutateAuthProfileProjection(projection, mutation);
          const after = authProfileProjectionSnapshot(projection);
          if (after === before && sharedAuthStoreIsCurrent(database)) {
            database.exec('COMMIT');
            return false;
          }
          writeAuthProfileCells(database, projection);
          database.exec('COMMIT');
          return true;
        } catch (error) {
          rollbackAuthProfileProjection(database);
          throw error;
        }
      } finally {
        database.close();
      }
    });
  } catch (error) {
    if (error instanceof AuthProfileSqliteError) throw error;
    throw new AuthProfileSqliteError('auth-profile-write-failed');
  }
}

async function retryAuthProfileSqliteBusy(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      if (attempt >= OPENCLAW_AUTH_PROFILE_WRITE_RETRY_DELAYS_MS.length) {
        throw new AuthProfileSqliteError('auth-profile-write-failed');
      }
      await new Promise((resolve) => setTimeout(resolve, OPENCLAW_AUTH_PROFILE_WRITE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

function authProfileProjectionAlreadyMatches(mutation) {
  if (!existsSync(path)) return false;
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}`);
      if (!hasAuthProfileStateTable(database)) return false;
      if (!sharedAuthStoreIsCurrent(database)) return false;
      const projection = readAuthProfileProjection(database);
      const before = authProfileProjectionSnapshot(projection);
      mutateAuthProfileProjection(projection, mutation);
      return authProfileProjectionSnapshot(projection) === before;
    } finally {
      database.close();
    }
  } catch (error) {
    if (isSqliteBusy(error)) return false;
    throw error;
  }
}

function ensureAuthProfileStateTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS config_machine_state (
      state_key TEXT NOT NULL PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
  `);
}

function hasAuthProfileStateTable(database) {
  return database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state' LIMIT 1")
    .get() !== undefined;
}

function readAuthProfileProjection(database) {
  return {
    store: readAuthProfileStoreCell(database),
    state: readAuthProfileStateCell(database),
  };
}

function readAuthProfileStoreCell(database) {
  const value = readAuthProfileCell(database, AUTH_PROFILES_STORE_STATE_KEY);
  if (value === undefined) return { version: 1, profiles: {} };
  if (!isAuthProfileStore(value)) throw new AuthProfileSqliteError('auth-profile-read-invalid');
  return {
    version: 1,
    profiles: { ...value.profiles },
  };
}

function readAuthProfileStateCell(database) {
  const value = readAuthProfileCell(database, AUTH_PROFILES_STATE_STATE_KEY);
  if (value === undefined) return { version: 1 };
  if (!isAuthProfileState(value)) throw new AuthProfileSqliteError('auth-profile-read-invalid');
  return {
    version: 1,
    order: value.order ? cloneAuthProfileOrder(value.order) : undefined,
    lastGood: value.lastGood ? { ...value.lastGood } : undefined,
  };
}

function readAuthProfileCell(database, stateKey) {
  const row = database
    .prepare('SELECT value_json FROM config_machine_state WHERE state_key = ?')
    .get(stateKey);
  if (typeof row?.value_json !== 'string') return undefined;
  if (Buffer.byteLength(row.value_json) > MAX_AUTH_PROFILES_BYTES) {
    throw new AuthProfileSqliteError('auth-profile-read-invalid');
  }
  try {
    return JSON.parse(row.value_json);
  } catch {
    throw new AuthProfileSqliteError('auth-profile-read-invalid');
  }
}

function writeAuthProfileCells(database, projection) {
  writeAuthProfileCell(database, AUTH_SHARED_STORE_STATE_KEY, AUTH_SHARED_STORE_STATE_VALUE);
  writeAuthProfileCell(database, AUTH_PROFILES_STORE_STATE_KEY, projection.store);
  writeAuthProfileCell(database, AUTH_PROFILES_STATE_STATE_KEY, normalizeAuthProfileState(projection.state));
}

function sharedAuthStoreIsCurrent(database) {
  const row = database
    .prepare('SELECT value_json FROM config_machine_state WHERE state_key = ?')
    .get(AUTH_SHARED_STORE_STATE_KEY);
  return row?.value_json === JSON.stringify(AUTH_SHARED_STORE_STATE_VALUE);
}

function authProfileProjectionSnapshot(projection) {
  return JSON.stringify({
    store: projection.store,
    state: normalizeAuthProfileState(projection.state),
  });
}

function writeAuthProfileCell(database, stateKey, value) {
  const valueJson = JSON.stringify(value);
  if (valueJson === undefined || Buffer.byteLength(valueJson) > MAX_AUTH_PROFILES_BYTES) {
    throw new AuthProfileSqliteError('auth-profile-write-failed');
  }
  database
    .prepare(`
      INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at_ms = excluded.updated_at_ms
    `)
    .run(stateKey, valueJson, Date.now());
}

function normalizeAuthProfileState(state) {
  const next = { version: 1 };
  if (state.order && Object.keys(state.order).length > 0) next.order = state.order;
  if (state.lastGood && Object.keys(state.lastGood).length > 0) next.lastGood = state.lastGood;
  return next;
}

function rollbackAuthProfileProjection(database) {
  try {
    if (database.isTransaction) database.exec('ROLLBACK');
  } catch {
    // Ignore rollback failure; the original write/read error is the useful boundary.
  }
}

function cloneAuthProfileOrder(order) {
  return Object.fromEntries(Object.entries(order).map(([provider, profileIds]) => [provider, [...profileIds]]));
}

function isSqliteBusy(error) {
  if (!isRecord(error)) return false;
  if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') return true;
  // node:sqlite exposes SQLite's numeric (possibly extended) result code.
  return error.code === 'ERR_SQLITE_ERROR' && Number.isInteger(error.errcode)
    && ((error.errcode & 0xff) === 5 || (error.errcode & 0xff) === 6);
}

function isAuthProfileStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const store = value;
  if (store.version !== 1 || !store.profiles || typeof store.profiles !== 'object' || Array.isArray(store.profiles)) {
    return false;
  }
  return Object.entries(store.profiles).every(([id, profile]) => isId(id) && isAuthProfile(profile));
}

function isAuthProfileState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value;
  return state.version === 1
    && (state.order === undefined || isAuthProfileOrder(state.order))
    && (state.lastGood === undefined || isAuthProfileLastGood(state.lastGood));
}

function isAuthProfileOrder(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.entries(value).every(([provider, profileIds]) => isProfileProviderName(provider)
      && Array.isArray(profileIds)
      && profileIds.every(isId));
}

function isAuthProfileLastGood(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.entries(value).every(([provider, profileId]) => isProfileProviderName(provider) && isId(profileId));
}

function isAuthProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value;
  if (!isProfileProviderName(profile.provider)) return false;
  if (profile.type === 'api_key') {
    return hasOneSecret(profile.key, profile.keyRef)
      && Object.entries(profile).every(([key, profileValue]) => isCommonAuthProfileField(key, profileValue)
        || key === 'key' && isSecret(profileValue)
        || key === 'keyRef' && isSecretRef(profileValue));
  }
  if (profile.type === 'token') {
    return hasOneSecret(profile.token, profile.tokenRef)
      && Object.entries(profile).every(([key, profileValue]) => isCommonAuthProfileField(key, profileValue)
        || key === 'token' && isSecret(profileValue)
        || key === 'tokenRef' && isSecretRef(profileValue)
        || key === 'expires' && isRevision(profileValue));
  }
  if (profile.type !== 'oauth'
    || !isSecret(profile.access)
    || !isSecret(profile.refresh)
    || !isRevision(profile.expires)) {
    return false;
  }
  return Object.entries(profile).every(([key, profileValue]) => isCommonAuthProfileField(key, profileValue)
    || ['access', 'refresh'].includes(key) && isSecret(profileValue)
    || key === 'expires' && isRevision(profileValue)
    || ['clientId', 'enterpriseUrl', 'projectId', 'accountId', 'chatgptPlanType', 'idToken'].includes(key) && typeof profileValue === 'string');
}

function isSecretRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value;
  return (ref.source === 'env' || ref.source === 'file' || ref.source === 'exec')
    && isProfileProviderName(ref.provider)
    && isSecret(ref.id);
}

function hasOneSecret(left, right) {
  return (isSecret(left) && right === undefined) || (left === undefined && isSecretRef(right));
}

function isCommonAuthProfileField(key, value) {
  if (key === 'type') return value === 'api_key' || value === 'token' || value === 'oauth';
  if (key === 'provider') return isProfileProviderName(value);
  if (key === 'copyToAgents') return typeof value === 'boolean';
  if (key === 'email' || key === 'displayName') return typeof value === 'string';
  if (key === 'metadata') return isStringRecord(value);
  return false;
}

function isStringRecord(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
}

function isProfileProviderName(value) {
  return typeof value === 'string' && value.length <= MAX_PROVIDER_KEY_BYTES && /^[A-Za-z0-9_.-]+$/.test(value);
}

function isRevision(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_BYTES && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function isSecret(value) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_SECRET_BYTES && !value.includes('\0');
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
