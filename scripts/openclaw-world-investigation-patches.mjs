import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const PATCH_ID = 'native-world-investigation';
const RUNTIME_FILE = 'matcha-world-investigation.mjs';

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? listJavaScriptFiles(file) : /\.(?:mjs|js)$/.test(entry.name) ? [file] : [];
  });
}

function locateSingleJavaScriptFile(dist, prefix, markers) {
  const files = listJavaScriptFiles(dist).filter(file => path.basename(file).startsWith(prefix)
    && markers.every(marker => fs.readFileSync(file, 'utf8').includes(marker)));
  if (files.length !== 1) throw new Error(`${PATCH_ID}: expected one ${prefix} target, found ${files.length}`);
  return files[0];
}

function replaceOnce(source, before, after) {
  if (source.split(after).length === 2) return source;
  if (source.includes(after) || source.split(before).length !== 2) {
    throw new Error(`${PATCH_ID}: expected one source anchor: ${before.slice(0, 120)}`);
  }
  return source.replace(before, after);
}

function exportAlias(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const alias = source.match(new RegExp(`\\b${name} as ([\\w$]+)\\b`))?.[1];
  if (!alias) throw new Error(`${PATCH_ID}: missing ${name} export`);
  return alias;
}

function nativeImport(file, names) {
  return `import { ${names.map(name => `${exportAlias(file, name)} as ${name}`).join(', ')} } from "./${path.basename(file)}";`;
}

// This is emitted into the product bundle, not loaded by the patch installer.
const RUNTIME = String.raw`
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, createSecretKey, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
const execution = new AsyncLocalStorage();
const held = new Map();
const decimal = /^(0|[1-9][0-9]*)$/;
const dimensions = { maxWallTime: "wall_time", maxSteps: "steps", maxSourceReads: "source_reads", maxRows: "rows", maxBytes: "bytes", maxModelCalls: "model_calls", maxInputTokens: "input_tokens", maxOutputTokens: "output_tokens" };
const effects = new Set(["pure", "source_read", "clock_read", "probabilistic", "external_write"]);
let projection;
export class MatchaWorldInvestigationError extends Error {
  constructor(kind, details = {}) {
    super("World investigation: " + kind);
    this.name = "MatchaWorldInvestigationError";
    this.code = "WORLD_INVESTIGATION_REJECTED";
    this.worldInvestigation = { kind, ...details };
  }
}
function failureCode(error, params, current) {
  if (!current?.stageAttempted && !current?.receipt.accepted) {
    try {
      const resolved = scope(params);
      const result = withOpenClawAgentDatabaseReadOnly(database => !database.db.prepare("SELECT 1 FROM session_pending_inputs WHERE session_key = ? AND session_id = ? AND run_id = ?").get(params.sessionKey, params.sessionId, params.requestId ?? params.idempotencyKey), toDatabaseOptions(resolved), { throwOnMissingTable: true });
      if (result.found && result.value === true) return "WORLD_INVESTIGATION_NOT_SENT";
    } catch {}
  }
  return error.code;
}
function reject(kind, details) { throw new MatchaWorldInvestigationError(kind, details); }
export function canonicalMatchaWorld(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalMatchaWorld).join(",") + "]";
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalMatchaWorld(value[key])).join(",") + "}";
  }
  reject("invalid_input");
}
function hash(value) { return "sha256:" + createHash("sha256").update(value).digest("hex"); }
function requestBytes(params) {
  const copy = structuredClone(params);
  delete copy.worldInvestigation.producer.mac;
  return Buffer.from(canonicalMatchaWorld(copy));
}
export function readMatchaWorldProjection() {
  if (projection) return projection;
  const location = process.env.MATCHA_WORLD_PROJECTION;
  if (!location || !path.isAbsolute(location)) reject("private_projection_unavailable");
  const file = openSync(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > 4096 || process.platform !== "win32" && (stat.mode & 0o077) !== 0) reject("private_projection_invalid");
    const bytes = Buffer.alloc(4097);
    try {
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(file, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > 4096) reject("private_projection_invalid");
      const value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "endpoint,runtimeInstance,signingKey" || typeof value.endpoint !== "string" || typeof value.signingKey !== "string") reject("private_projection_invalid");
      const endpoint = new URL(value.endpoint);
      if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/api/world/peer" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || typeof value.runtimeInstance !== "string" || !value.runtimeInstance || value.runtimeInstance.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.runtimeInstance)) reject("private_projection_invalid");
      const key = Buffer.from(value.signingKey, "base64url");
      try {
        if (key.length !== 32 || key.toString("base64url") !== value.signingKey) reject("private_projection_invalid");
        projection = Object.freeze({ endpoint, runtimeInstance: value.runtimeInstance, signingKey: createSecretKey(key) });
        return projection;
      } finally { key.fill(0); }
    } finally { bytes.fill(0); }
  } finally { closeSync(file); }
}
// Read before plugins can remove the private bootstrap locator; one cached key owner.
if (process.env.MATCHA_WORLD_PROJECTION) readMatchaWorldProjection();
function u64(value) {
  if (typeof value !== "string" || !decimal.test(value) || BigInt(value) > 18446744073709551615n) reject("invalid_input");
  return BigInt(value);
}
function scope(params) {
  if (![params.agentId, params.sessionKey, params.sessionId].every(value => typeof value === "string" && value.length > 0)) reject("invalid_input");
  return resolveSqliteTranscriptScope({ agentId: params.agentId, sessionKey: params.sessionKey, sessionId: params.sessionId });
}
function hasPrivateColumn(db) {
  return db.prepare("PRAGMA table_info(session_pending_inputs)").all().some(column => column.name === "world_investigation_json");
}
function rowFor(database, params) {
  if (!hasPrivateColumn(database.db)) return;
  return database.db.prepare("SELECT * FROM session_pending_inputs WHERE session_key = ? AND session_id = ? AND run_id = ? AND world_investigation_json IS NOT NULL").get(params.sessionKey, params.sessionId, params.requestId ?? params.idempotencyKey);
}
function read(params) {
  const resolved = scope(params);
  const result = withOpenClawAgentDatabaseReadOnly(database => {
    const row = rowFor(database, params);
    return row ? { row, receipt: JSON.parse(row.world_investigation_json) } : null;
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : null;
}
function publicReceipt(receipt) { return receipt ? structuredClone(receipt) : null; }
function assertExact(receipt, params, requireCorrelation = false) {
  if (!receipt || params.requestDigest !== undefined && receipt.requestDigest !== params.requestDigest || params.runId !== undefined && receipt.acceptedParams.idempotencyKey !== params.runId) reject("request_conflict");
  if (requireCorrelation && canonicalMatchaWorld(params.correlation) !== canonicalMatchaWorld(receipt.accepted)) reject("request_conflict");
}
function mutate(params, update, exactCorrelation = false) {
  const resolved = scope(params);
  return runOpenClawAgentWriteTransaction(database => {
    const row = rowFor(database, params);
    if (!row) reject("unknown");
    const receipt = JSON.parse(row.world_investigation_json);
    assertExact(receipt, params, exactCorrelation);
    update(receipt, row, database);
    const changed = database.db.prepare("UPDATE session_pending_inputs SET world_investigation_json = ? WHERE input_id = ? AND world_investigation_json = ?").run(JSON.stringify(receipt), row.input_id, row.world_investigation_json);
    if (Number(changed.changes) !== 1) reject("request_conflict");
    return publicReceipt(receipt);
  }, toDatabaseOptions(resolved));
}
export function assertMatchaWorldRecoveryNotUnscoped(params) {
  if (!params.requestId || !params.agentId || !params.sessionKey || !params.sessionId) return;
  const found = read(params);
  if (found && execution.getStore()?.receipt.requestDigest !== found.receipt.requestDigest) reject("unsupported_transport", { transport: "unreleased_recovery" });
}
export function inspectMatchaWorldInvestigation(params) {
  const found = read(params);
  if (!found) return { worldInvestigation: null };
  assertExact(found.receipt, params);
  return { worldInvestigation: publicReceipt(found.receipt) };
}
function verify(params) {
  const world = params.worldInvestigation;
  if (!world || world.version !== 1 || Object.keys(world).some(key => !["version", "bindingId", "allowedEffects", "budget", "issuedAtMs", "expiresAtMs", "producer"].includes(key)) || typeof world.bindingId !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(world.bindingId) || !Array.isArray(world.allowedEffects) || new Set(world.allowedEffects).size !== world.allowedEffects.length || world.allowedEffects.some(effect => !effects.has(effect))) reject("invalid_input");
  const budget = world.budget;
  if (!budget || Object.keys(budget).some(key => !(key in dimensions) && key !== "maxCost" && key !== "deadline")) reject("invalid_input");
  for (const key of Object.keys(dimensions)) u64(budget[key]);
  if (u64(budget.maxWallTime) === 0n || u64(budget.maxSteps) === 0n) reject("invalid_input");
  if (!Number.isSafeInteger(world.issuedAtMs) || !Number.isSafeInteger(world.expiresAtMs) || world.issuedAtMs < 0 || world.expiresAtMs <= world.issuedAtMs) reject("invalid_input");
  const material = readMatchaWorldProjection();
  if (!world.producer || Object.keys(world.producer).some(key => !["runtimeInstance", "mac"].includes(key)) || world.producer.runtimeInstance !== material.runtimeInstance || typeof world.producer.mac !== "string") reject("invalid_producer");
  const bytes = requestBytes(params);
  const expected = createHmac("sha256", material.signingKey).update(Buffer.from("matcha.world.investigation.openclaw.v1\n")).update(bytes).digest();
  const actual = Buffer.from(world.producer.mac, "base64url");
  if (actual.length !== expected.length || actual.toString("base64url") !== world.producer.mac || !timingSafeEqual(actual, expected)) reject("invalid_producer");
  const now = Date.now();
  if (world.issuedAtMs > now || world.expiresAtMs <= now) reject("expired");
  if (budget.maxCost !== null && budget.maxCost !== undefined) reject("unsupported_budget", { dimensions: ["cost"] });
  if (params.attachments?.length || params.mentions?.length || params.intent || params.systemInputProvenance || params.systemProvenanceReceipt || params.replyToId || params.toolBindings || params.deliver === true || params.suppressCommandInterpretation !== true || params.message.trimStart().startsWith("/")) reject("unsupported_transport", { transport: "non_atomic_chat_input" });
  const wall = u64(budget.maxWallTime);
  const explicit = budget.deadline == null ? Infinity : Date.parse(budget.deadline);
  if (!Number.isFinite(explicit) && budget.deadline != null) reject("invalid_input");
  const deadlineMs = Math.min(world.expiresAtMs, now + Number(wall > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : wall), explicit);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= now) reject("expired");
  return { version: 1, acceptedParams: structuredClone(params), requestDigest: hash(bytes), inputDelivery: "not_started", accepted: null, acceptedAtMs: now, deadlineMs, phase: "held", cancelRequestedAtMs: null, childrenJoined: false, pendingIo: 0, usage: { kind: "unavailable" }, facts: { coverage: "unknown", ownership: "native_exclusive", inputScope: "whole_input", terminal: null, actual: {}, reserved: {}, io: [], worldSourceAccounting: "world_owner" } };
}
export async function withMatchaWorldChatSend(params, respond, run) {
  if (params?.worldInvestigation === undefined) return run(respond);
  let current;
  try {
    scope(params);
    const found = read(params);
    if (found) {
      if (hash(requestBytes(params)) !== found.receipt.requestDigest || canonicalMatchaWorld(params) !== canonicalMatchaWorld(found.receipt.acceptedParams)) reject("request_conflict");
      respond(true, { runId: found.row.run_id, status: "accepted", worldInvestigation: publicReceipt(found.receipt) });
      return;
    }
    const receipt = verify(params);
    current = { receipt, params, runtime: null, respond, responded: false, stageAttempted: false, controller: new AbortController(), admission: "open", dispatch: "not_started", handlerFinished: false };
    current.children = new Set();
    current.attempts = new Set();
    current.releaseWaiters = [];
    current.expiryTimer = setTimeout(() => {
      current.controller.abort(new MatchaWorldInvestigationError("expired"));
      current.abort?.();
      const error = new MatchaWorldInvestigationError("expired");
      held.get(receipt.requestDigest)?.reject(error);
      for (const waiter of current.releaseWaiters.splice(0)) waiter.reject(error);
    }, Math.min(2147483647, Math.max(1, receipt.deadlineMs - Date.now())));
    current.expiryTimer.unref();
    return await execution.run(current, async () => {
      try {
        return await run((ok, payload, error, extra) => {
          if (current.responded) return;
          if (!ok) {
            current.responded = true;
            const failure = error ?? { code: "WORLD_INVESTIGATION_REJECTED", message: "World investigation start was rejected" };
            return respond(false, payload, { ...failure, code: failureCode(failure, params, current) }, extra);
          }
          current.responded = true;
          return respond(ok, payload, error, extra);
        });
      } finally {
        current.handlerFinished = true;
        if (current.dispatch === "not_started") {
          closeMatchaWorldAdmission();
          await joinMatchaWorldChildren();
          if (current.stageAttempted) finishMatchaWorldInvestigation(params.idempotencyKey, { status: "failed", source: "setup_finished", queued: false, acceptedMessageInjection: false });
          else if (current.expiryTimer) clearTimeout(current.expiryTimer);
        }
      }
    });
  } catch (error) {
    if (!(error instanceof MatchaWorldInvestigationError)) throw error;
    if (!current?.responded) respond(false, undefined, { code: failureCode(error, params, current), message: error.message, details: error.worldInvestigation });
  }
}
export function currentMatchaWorldInvestigation() { return execution.getStore(); }
export function assertMatchaWorldAdmissionOpen() {
  const current = execution.getStore();
  if (current && (current.admission !== "open" || current.controller.signal.aborted)) reject("execution_not_current");
}
export function beginMatchaWorldDispatch() {
  const current = execution.getStore();
  if (!current) return;
  assertMatchaWorldAdmissionOpen();
  if (current.dispatch !== "not_started") reject("request_conflict");
  current.dispatch = "running";
}
export function closeMatchaWorldAdmission(dispatchFinalized = false) {
  const current = execution.getStore();
  if (!current) return;
  if (dispatchFinalized) current.dispatch = "finalized";
  if (current.admission === "closed") return;
  current.admission = "closed";
  const error = new MatchaWorldInvestigationError("execution_not_current");
  current.controller.abort(error);
  current.abort?.();
  held.get(current.receipt.requestDigest)?.reject(error);
  for (const waiter of current.releaseWaiters.splice(0)) waiter.reject(error);
}
export function bindMatchaWorldPendingOwner(identity) {
  const current = execution.getStore();
  if (!current) return () => {};
  assertMatchaWorldAdmissionOpen();
  if (current.pendingOwner || identity.runId !== current.params.idempotencyKey || identity.sessionId !== current.params.sessionId || identity.sessionKey !== current.params.sessionKey || identity.lifecycleGeneration !== getAgentEventLifecycleGeneration()) reject("request_conflict");
  const owner = { ...identity, finished: false };
  current.pendingOwner = owner;
  return () => { owner.finished = true; };
}
export function bindMatchaWorldWorkerCancellation(store, claim, operationalRunInstance, source, delegatedAuthority, assertRunActive) {
  const current = execution.getStore();
  if (!current) return () => {};
  assertMatchaWorldAdmissionOpen();
  assertRunActive();
  const context = getAgentRunContext(operationalRunInstance.runId);
  const params = structuredClone(current.params);
  const owner = current.pendingOwner;
  const requestDigest = current.receipt.requestDigest;
  if (!store.validateTurnClaim(claim) || getActiveAgentRunDelegatedAuthority(operationalRunInstance) !== delegatedAuthority || operationalRunInstance.runId !== claim.runId || !context || context.delegatedAuthority !== delegatedAuthority || context.agentId !== source.agentId || context.sessionKey !== source.sessionKey || context.sessionId !== claim.sessionId || context.lifecycleGeneration !== delegatedAuthority.lifecycleGeneration || params.idempotencyKey !== claim.runId || params.agentId !== source.agentId || params.sessionKey !== source.sessionKey || params.sessionId !== claim.sessionId || !owner || owner.finished || owner.runId !== claim.runId || owner.sessionKey !== params.sessionKey || owner.sessionId !== claim.sessionId || owner.lifecycleGeneration !== delegatedAuthority.lifecycleGeneration || owner.lifecycleGeneration !== getAgentEventLifecycleGeneration()) reject("execution_not_current");
  const pending = Object.freeze({ ...owner });
  const databaseOptions = toDatabaseOptions(scope(params));
  const originalDatabase = getOpenClawAgentDatabaseIfOpen(databaseOptions);
  if (!originalDatabase || originalDatabase.path !== pending.databasePath) reject("unknown");
  const exactReceipt = database => {
    if (database !== originalDatabase) reject("unknown");
    const row = rowFor(database, params);
    if (!row) reject("unknown");
    const receipt = JSON.parse(row.world_investigation_json);
    if (row.input_id !== pending.inputId || row.run_id !== params.idempotencyKey || row.idempotency_key !== pending.idempotencyKey || row.session_key !== pending.sessionKey || row.session_id !== pending.sessionId || row.lifecycle_generation !== pending.lifecycleGeneration || row.message_json !== pending.messageJson || receipt.requestDigest !== requestDigest || canonicalMatchaWorld(receipt.acceptedParams) !== canonicalMatchaWorld(params) || hash(requestBytes(receipt.acceptedParams)) !== requestDigest || receipt.nativeInstanceId !== undefined && receipt.nativeInstanceId !== String(pending.lifecycleGeneration) || receipt.accepted && (receipt.accepted.acceptedInputId !== pending.inputId || receipt.accepted.nativeInstanceId !== String(pending.lifecycleGeneration))) reject("request_conflict");
    return { row, receipt };
  };
  const { receipt } = exactReceipt(originalDatabase);
  if (receipt.cancelRequestedAtMs !== null || receipt.phase === "terminal" || receipt.settledAtMs != null || Date.now() >= receipt.deadlineMs) reject("execution_not_current");
  // Retained only for cancellation; a closed claim must never regain execution authority.
  return () => {
    const database = getOpenClawAgentDatabaseIfOpen(databaseOptions);
    if (database !== originalDatabase || database.db.isTransaction !== false) reject("unknown");
    const committed = runOpenClawAgentWriteTransaction(database => {
      const { row, receipt } = exactReceipt(database);
      if (receipt.cancelRequestedAtMs === null) receipt.cancelRequestedAtMs = Date.now();
      if (receipt.phase === "held") receipt.phase = "cancel_requested";
      const changed = database.db.prepare("UPDATE session_pending_inputs SET world_investigation_json = ? WHERE input_id = ? AND world_investigation_json = ?").run(JSON.stringify(receipt), row.input_id, row.world_investigation_json);
      if (Number(changed.changes) !== 1) reject("request_conflict");
      return publicReceipt(receipt);
    }, databaseOptions);
    current.receipt = committed;
  };
}
export function assertMatchaWorldUnsupported(transport) {
  if (execution.getStore()) reject("unsupported_transport", { transport });
}
export function assertMatchaWorldReleased() {
  const current = execution.getStore();
  if (current) checkCurrent(current);
}
export async function awaitMatchaWorldRelease() {
  const current = execution.getStore();
  if (!current) return;
  assertMatchaWorldAdmissionOpen();
  if (current.receipt.phase !== "running") await new Promise((resolve, rejectWait) => current.releaseWaiters.push({ resolve, reject: rejectWait }));
  checkCurrent(current);
}
export function assertMatchaWorldDeferredOwner(previous, current = execution.getStore()) {
  if (previous !== current && (previous || current)) reject("unsupported_transport", { transport: "cross_input_maintenance_coalescing" });
}
export function trackMatchaWorldChild(start) {
  assertMatchaWorldAdmissionOpen();
  const promise = start();
  const current = execution.getStore();
  if (!current || !promise || typeof promise.then !== "function") return promise;
  current.children.add(promise);
  promise.then(() => current.children.delete(promise), () => current.children.delete(promise));
  return promise;
}
export async function joinMatchaWorldChildren() {
  const current = execution.getStore();
  if (!current) return;
  while (current.children.size) await Promise.allSettled([...current.children]);
  current.allChildrenJoined = true;
}
export function recordMatchaWorldTerminal(terminal) {
  const current = execution.getStore();
  if (current) current.terminal = structuredClone(terminal);
}
export function createMatchaWorldDeferredChild() {
  const current = execution.getStore();
  if (!current) return;
  let resolve;
  let started = false;
  let finished = false;
  trackMatchaWorldChild(() => new Promise(done => { resolve = done; }));
  const child = {
    finish() {
      if (started) return;
      if (finished) return;
      finished = true;
      resolve();
    },
    expired: () => finished || current.admission !== "open" || Date.now() >= current.receipt.deadlineMs || current.receipt.cancelRequestedAtMs !== null,
    run: async operation => {
      if (child.expired()) reject("execution_not_current");
      started = true;
      try { return await execution.run(current, operation); }
      finally { started = false; child.finish(); }
    }
  };
  return child;
}
export function recordMatchaWorldToolDrain(result) {
  const current = execution.getStore();
  if (current && result?.kind === "timeout") current.toolDrainUnknown = true;
}
export function stageMatchaWorldInvestigation() {
  assertMatchaWorldAdmissionOpen();
  const current = execution.getStore();
  if (current) current.stageAttempted = true;
  return current ? JSON.stringify(current.receipt) : null;
}
export function promoteMatchaWorldInvestigation(database, pending, anchor) {
  const row = database.db.prepare("SELECT * FROM session_pending_inputs WHERE input_id = ?").get(pending.inputId);
  if (!row?.world_investigation_json) return false;
  if (!anchor || row.consumed_event_id != null && row.consumed_event_id !== anchor.entryId) reject("request_conflict");
  const receipt = JSON.parse(row.world_investigation_json);
  if (row.consumed_event_id != null) return true;
  const current = execution.getStore();
  if (!current || receipt.requestDigest !== current.receipt.requestDigest || row.run_id !== current.params.idempotencyKey || anchor.entryId !== row.input_id) reject("request_conflict");
  receipt.transcriptAnchor = { agentId: anchor.agentId, sessionId: anchor.sessionId, entryId: anchor.entryId };
  receipt.nativeInstanceId = String(getAgentEventLifecycleGeneration());
  const changed = database.db.prepare("UPDATE session_pending_inputs SET consumed_event_id = ?, world_investigation_json = ? WHERE input_id = ? AND world_investigation_json = ? AND consumed_event_id IS NULL").run(anchor.entryId, JSON.stringify(receipt), row.input_id, row.world_investigation_json);
  if (Number(changed.changes) !== 1) reject("request_conflict");
  current.receipt = receipt;
  return true;
}
export function assertMatchaWorldRetained(database, sessionKey, sessionId) {
  if (!hasPrivateColumn(database.db)) return;
  const rows = sessionId
    ? database.db.prepare("SELECT world_investigation_json FROM session_pending_inputs WHERE session_id = ? AND world_investigation_json IS NOT NULL").all(sessionId)
    : database.db.prepare("SELECT world_investigation_json FROM session_pending_inputs WHERE session_key = ? AND world_investigation_json IS NOT NULL").all(sessionKey);
  if (rows.some(row => JSON.parse(row.world_investigation_json).settledAtMs == null)) reject("unsettled_input_retained");
}
export function matchaWorldHookCorrelation(runId) {
  const current = execution.getStore();
  if (!current?.receipt.accepted) return;
  checkCurrent(current);
  if (!current.attempts.has(runId) || current.receipt.accepted.nativeInstanceId !== String(getAgentEventLifecycleGeneration())) reject("execution_not_current");
  return Object.freeze(structuredClone(current.receipt.accepted));
}
function checkCurrent(current) {
  assertMatchaWorldAdmissionOpen();
  const found = read(current.params);
  if (!found || found.receipt.requestDigest !== current.receipt.requestDigest || found.receipt.phase !== "running" || found.receipt.cancelRequestedAtMs !== null || Date.now() >= found.receipt.deadlineMs || found.receipt.accepted?.nativeInstanceId !== String(getAgentEventLifecycleGeneration())) reject("execution_not_current");
  return found.receipt;
}
export function admitMatchaWorldStep(kind) {
  const current = execution.getStore();
  if (!current) return;
  checkCurrent(current);
  current.receipt = mutate({ ...current.params, requestDigest: current.receipt.requestDigest }, receipt => {
    const used = u64(receipt.facts.actual.steps ?? "0");
    if (used >= u64(receipt.acceptedParams.worldInvestigation.budget.maxSteps)) reject("budget_exhausted", { dimensions: ["steps"] });
    receipt.facts.actual.steps = String(used + 1n);
    receipt.facts.lastStepKind = kind;
  });
}
const worldTools = { world_discover: ["source_read"], world_query: ["source_read"], world_explain: ["source_read"], world_action_propose: ["pure", "source_read"], world_action_status: ["source_read"], world_observe: ["pure"], world_change_propose: ["pure"], world_branch_test: ["pure"], world_action_submit: ["external_write"] };
export function assertMatchaWorldTool(toolName) {
  const current = execution.getStore();
  if (!current) return;
  assertMatchaWorldAdmissionOpen();
  const required = worldTools[toolName];
  if (!required) reject("unsupported_transport", { transport: "unmetered_tool", toolName });
  for (const effect of required) if (!current.params.worldInvestigation.allowedEffects.includes(effect)) reject("effect_denied", { effect });
}
export async function withMatchaWorldTool(toolName, toolCallId, invoke) {
  const current = execution.getStore();
  if (!current) return invoke();
  assertMatchaWorldTool(toolName);
  admitMatchaWorldStep("tool");
  const id = "tool:" + toolCallId;
  current.receipt = mutate({ ...current.params, requestDigest: current.receipt.requestDigest }, receipt => {
    if (receipt.facts.io.some(io => io.id === id)) reject("request_conflict");
    receipt.inputDelivery = "may_have_sent";
    receipt.pendingIo += 1;
    receipt.facts.io.push({ id, kind: "world_tool", effect: worldTools[toolName], state: "admitted", admittedAtMs: Date.now(), sourceAccounting: "world_owner" });
  });
  try { return await invoke(); }
  finally {
    current.receipt = mutate({ ...current.params, requestDigest: current.receipt.requestDigest }, receipt => {
      const io = receipt.facts.io.find(io => io.id === id);
      if (!io || io.state !== "admitted") reject("request_conflict");
      io.state = "joined";
      io.joinedAtMs = Date.now();
      receipt.pendingIo -= 1;
    });
  }
}
export function assertMatchaWorldModelTransport(model) {
  const current = execution.getStore();
  if (!current) return;
  assertMatchaWorldAdmissionOpen();
  if (current.receipt.accepted) checkCurrent(current);
  if (!current.params.worldInvestigation.allowedEffects.includes("probabilistic")) reject("effect_denied", { effect: "probabilistic" });
  if (model?.api !== "anthropic-messages") reject("unsupported_transport", { transport: model?.api ?? "unknown", dimensions: ["input_tokens"] });
}
function liveSignal(signal) {
  const current = execution.getStore();
  checkCurrent(current);
  const remaining = current.receipt.deadlineMs - Date.now();
  if (remaining <= 0) reject("expired");
  return AbortSignal.any([current.controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(Math.min(2147483647, remaining))]);
}
function reserveIo(kind, reservation, proof) {
  const current = execution.getStore();
  checkCurrent(current);
  let id;
  current.receipt = mutate({ ...current.params, requestDigest: current.receipt.requestDigest }, receipt => {
    const budget = receipt.acceptedParams.worldInvestigation.budget;
    for (const [key, value] of Object.entries(reservation)) {
      const max = "max" + key[0].toUpperCase() + key.slice(1);
      const used = u64(receipt.facts.actual[key] ?? "0");
      const reserved = u64(receipt.facts.reserved[key] ?? "0");
      if (used + reserved + u64(value) > u64(budget[max])) reject("budget_exhausted", { dimensions: [dimensions[max]] });
    }
    for (const [key, value] of Object.entries(reservation)) receipt.facts.reserved[key] = String(u64(receipt.facts.reserved[key] ?? "0") + u64(value));
    id = "io:" + receipt.facts.io.length;
    receipt.inputDelivery = "may_have_sent";
    receipt.pendingIo += 1;
    receipt.facts.io.push({ id, kind, state: "admitted", admittedAtMs: Date.now(), reservation, proof });
  });
  return { current, id };
}
function observeIo(permit, actual, raw, complete) {
  permit.current.receipt = mutate({ ...permit.current.params, requestDigest: permit.current.receipt.requestDigest }, receipt => {
    const io = receipt.facts.io.find(io => io.id === permit.id);
    if (!io || io.state !== "admitted") reject("request_conflict");
    io.state = complete ? "joined" : "unknown";
    io.raw = raw;
    io.actual = actual;
    io.joinedAtMs = Date.now();
    for (const [key, value] of Object.entries(io.reservation)) {
      receipt.facts.reserved[key] = String(u64(receipt.facts.reserved[key]) - u64(value));
      const observed = actual[key];
      if (observed === undefined || u64(observed) > u64(value)) {
        io.state = "unknown";
        // Retain the full reservation when actual consumption cannot be proven.
        receipt.facts.reserved[key] = String(u64(receipt.facts.reserved[key]) + u64(value));
      } else receipt.facts.actual[key] = String(u64(receipt.facts.actual[key] ?? "0") + u64(observed));
    }
    receipt.pendingIo -= 1;
  });
}
const anthropicCountFields = new Set(["model", "messages", "system", "tools", "tool_choice", "thinking", "cache_control", "context_management", "mcp_servers", "output_config", "output_format", "speed"]);
const anthropicGenerationFields = new Set(["max_tokens", "stream", "metadata", "temperature", "top_p", "top_k", "stop_sequences", "service_tier"]);
function tokenCount(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined; }
export async function prepareMatchaWorldModelFetch(model, url, init, fetchCount) {
  if (!execution.getStore()) return { init, observe: response => response, fail() {} };
  assertMatchaWorldModelTransport(model);
  const current = execution.getStore();
  if (typeof init?.body !== "string") reject("unsupported_budget", { dimensions: ["input_tokens"] });
  let body;
  try { body = JSON.parse(init.body); } catch { reject("unsupported_budget", { dimensions: ["input_tokens"] }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string" || !body.model || !tokenCount(body.max_tokens) || body.max_tokens <= 0) reject("unsupported_budget", { dimensions: ["output_tokens"] });
  if (Object.keys(body).some(key => !anthropicCountFields.has(key) && !anthropicGenerationFields.has(key))) reject("unsupported_budget", { dimensions: ["input_tokens"] });
  if (body.mcp_servers?.length || body.tools?.some(tool => !tool || typeof tool !== "object" || tool.type !== undefined && tool.type !== "custom")) reject("unsupported_transport", { transport: "unbounded_provider_tool" });
  const countUrl = new URL(url);
  if (!/\/messages$/.test(countUrl.pathname)) reject("unsupported_transport", { transport: "unproven_count_endpoint" });
  countUrl.pathname += "/count_tokens";
  if (!current.params.worldInvestigation.allowedEffects.includes("source_read")) reject("effect_denied", { effect: "source_read" });
  const countBody = JSON.stringify(Object.fromEntries(Object.entries(body).filter(([key]) => anthropicCountFields.has(key))));
  const headers = new Headers(init.headers);
  headers.delete("content-length");
  headers.set("accept", "application/json");
  if (countUrl.searchParams.get("beta") === "true") {
    const beta = new Set((headers.get("anthropic-beta") ?? "").split(",").map(value => value.trim()).filter(Boolean));
    beta.add("token-counting-2024-11-01");
    headers.set("anthropic-beta", [...beta].join(","));
  }
  const requestSize = Buffer.byteLength(countBody);
  const beforeCount = checkCurrent(current);
  const countBytes = u64(current.params.worldInvestigation.budget.maxBytes) - u64(beforeCount.facts.actual.bytes ?? "0") - u64(beforeCount.facts.reserved.bytes ?? "0");
  if (countBytes <= BigInt(requestSize)) reject("budget_exhausted", { dimensions: ["bytes"] });
  const responseLimit = Number(countBytes - BigInt(requestSize) < 65536n ? countBytes - BigInt(requestSize) : 65536n);
  const countPermit = reserveIo("input_token_count", { sourceReads: "1", rows: "1", bytes: String(requestSize + responseLimit) }, { endpoint: countUrl.toString(), preparedRequestDigest: hash(canonicalMatchaWorld({ body: JSON.parse(countBody), beta: headers.get("anthropic-beta"), version: headers.get("anthropic-version") })) });
  let count;
  let countObserved = false;
  let responseBytes = 0;
  try {
    const response = await fetchCount(countUrl.toString(), { ...init, method: "POST", body: countBody, headers, redirect: "error", signal: liveSignal(init.signal) });
    if (!response.ok || !response.body) reject("unsupported_budget", { dimensions: ["input_tokens"] });
    const reader = response.body.getReader();
    const chunks = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        responseBytes += chunk.value.byteLength;
        if (responseBytes > responseLimit) { await reader.cancel(); reject("budget_exhausted", { dimensions: ["bytes"] }); }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { reader.releaseLock(); }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    count = tokenCount(value.input_tokens);
    if (count === undefined) reject("unsupported_budget", { dimensions: ["input_tokens"] });
    observeIo(countPermit, { sourceReads: "1", rows: "1", bytes: String(requestSize + responseBytes) }, value, true);
    countObserved = true;
  } finally {
    if (!countObserved) observeIo(countPermit, {}, { responseBytes: String(responseBytes), reason: "count_not_proven" }, false);
  }
  const fresh = checkCurrent(current);
  const remainingBytes = u64(current.params.worldInvestigation.budget.maxBytes) - u64(fresh.facts.actual.bytes ?? "0") - u64(fresh.facts.reserved.bytes ?? "0");
  const modelRequestBytes = Buffer.byteLength(init.body);
  if (remainingBytes <= BigInt(modelRequestBytes)) reject("budget_exhausted", { dimensions: ["bytes"] });
  const modelResponseLimit = remainingBytes - BigInt(modelRequestBytes);
  const permit = reserveIo("model_http", { modelCalls: "1", inputTokens: count, outputTokens: String(body.max_tokens), bytes: String(remainingBytes) }, { preparedRequestDigest: hash(canonicalMatchaWorld({ url, body })), inputCount: { method: countUrl.toString(), inputTokens: count }, outputCap: { field: "max_tokens", value: String(body.max_tokens) }, responseByteLimit: String(modelResponseLimit), requestBytes: String(modelRequestBytes) });
  let settled = false;
  const fail = reason => {
    if (settled) return;
    settled = true;
    observeIo(permit, {}, { reason }, false);
  };
  return {
    init: { ...init, signal: liveSignal(init.signal) },
    fail,
    observe(response) {
      if (!response.body) { fail("empty_response"); return response; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedBytes = 0n;
      let raw = {};
      let terminal = false;
      let stopReason;
      let parseUnknown = false;
      const ingest = value => {
        if (!value || typeof value !== "object") return;
        const usage = value.usage ?? value.message?.usage;
        if (usage && typeof usage === "object") raw = { ...raw, ...usage };
        if (value.type === "error" || value.error) parseUnknown = true;
        const reason = value.delta?.stop_reason ?? value.stop_reason ?? value.message?.stop_reason;
        if (reason != null) {
          stopReason = reason;
          if (!["end_turn", "tool_use", "stop_sequence"].includes(reason)) parseUnknown = true;
        }
        if (value.type === "message_stop" || value.type === "message" && value.stop_reason != null) terminal = true;
      };
      const parse = final => {
        if (!/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
          if (final) try { ingest(JSON.parse(buffer)); } catch { parseUnknown = true; }
          return;
        }
        buffer = buffer.replace(/\r\n/g, "\n");
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (data) try { ingest(JSON.parse(data)); } catch { parseUnknown = true; }
        }
        if (final && buffer.trim()) parseUnknown = true;
      };
      const bodyStream = new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (!chunk.done) {
              receivedBytes += BigInt(chunk.value.byteLength);
              if (receivedBytes > modelResponseLimit) { await reader.cancel(); reject("budget_exhausted", { dimensions: ["bytes"] }); }
              buffer += decoder.decode(chunk.value, { stream: true });
              if (buffer.length > 1048576) { parseUnknown = true; buffer = ""; }
              parse(false);
              controller.enqueue(chunk.value);
              return;
            }
            buffer += decoder.decode(); parse(true);
            const values = [raw.input_tokens, raw.cache_read_input_tokens, raw.cache_creation_input_tokens, raw.output_tokens].map(tokenCount);
            const complete = response.ok && terminal && stopReason !== undefined && !parseUnknown && values.every(value => value !== undefined);
            if (!settled) {
              settled = true;
              observeIo(permit, complete ? { modelCalls: "1", inputTokens: String(values.slice(0, 3).reduce((sum, value) => sum + BigInt(value), 0n)), outputTokens: values[3], bytes: String(BigInt(modelRequestBytes) + receivedBytes) } : { bytes: String(BigInt(modelRequestBytes) + receivedBytes) }, raw, complete);
            }
            reader.releaseLock(); controller.close();
          } catch (error) { fail("response_read_failed"); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { fail("response_cancelled"); reader.releaseLock(); } }
      });
      return new Response(bodyStream, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
  };
}
export function bindMatchaWorldAbort(abort) {
  const current = execution.getStore();
  if (current) {
    current.abort = abort;
    if (Date.now() >= current.receipt.deadlineMs) abort();
  }
}
export function deferMatchaWorldAck(payload, respond) {
  const current = execution.getStore();
  if (!current) return respond(true, payload);
  current.ackPayload = payload;
}
export async function prepareMatchaWorldAttempt(params, harness, builtIn, execute) {
  const current = execution.getStore();
  if (!current) return execute();
  assertMatchaWorldAdmissionOpen();
  if (current.receipt.accepted) {
    checkCurrent(current);
    if (!builtIn) reject("unsupported_transport", { transport: "non_native_auxiliary" });
    assertMatchaWorldModelTransport(params.model);
    current.attempts.add(params.runId);
    return execute();
  }
  if (!builtIn || params.sessionId !== current.params.sessionId || params.sessionKey !== current.params.sessionKey || params.runId !== current.params.idempotencyKey) reject("unsupported_transport", { transport: "non_atomic_native_attempt" });
  assertMatchaWorldModelTransport(params.model);
  await params.userTurnTranscriptRecorder?.persistApproved({ cwd: params.cwd ?? params.workspaceDir });
  assertMatchaWorldAdmissionOpen();
  current.receipt = mutate({ ...current.params, requestDigest: current.receipt.requestDigest }, receipt => {
    if (receipt.accepted || !receipt.transcriptAnchor || receipt.transcriptAnchor.sessionId !== params.sessionId || receipt.nativeInstanceId !== String(getAgentEventLifecycleGeneration())) reject("request_conflict");
    receipt.accepted = { bindingId: receipt.acceptedParams.worldInvestigation.bindingId, acceptedRequestId: receipt.acceptedParams.idempotencyKey, acceptedRunId: receipt.acceptedParams.idempotencyKey, acceptedInputId: receipt.transcriptAnchor.entryId, contentBudgetDigest: hash(canonicalMatchaWorld({ budget: null, content: receipt.acceptedParams.message })), nativeAttemptId: params.runId, nativeInstanceId: receipt.nativeInstanceId };
    receipt.facts.preparedHarnessId = harness.id;
  });
  current.attempts.add(params.runId);
  const key = current.receipt.requestDigest;
  if (held.has(key)) reject("request_conflict");
  const ready = new Promise((resolve, rejectReady) => {
    held.set(key, { current, resolve, reject: rejectReady, started: false });
    params.abortSignal?.addEventListener("abort", () => rejectReady(params.abortSignal.reason), { once: true });
  });
  current.respond(true, { ...current.ackPayload, runId: current.receipt.accepted.acceptedRunId, status: "accepted", worldInvestigation: publicReceipt(current.receipt) });
  current.responded = true;
  await ready;
  checkCurrent(current);
  return execute();
}
export function releaseMatchaWorldInvestigation(params) {
  if (typeof params.requestDigest !== "string" || !params.correlation) reject("invalid_input");
  const entry = held.get(params.requestDigest);
  if (entry && entry.current.admission !== "open") reject("execution_not_current");
  const receipt = mutate(params, receipt => {
    if (receipt.phase === "running") {
      if (!entry || receipt.accepted.nativeInstanceId !== String(getAgentEventLifecycleGeneration())) reject("unknown");
      return;
    }
    if (receipt.phase !== "held" || receipt.cancelRequestedAtMs !== null || Date.now() >= receipt.deadlineMs || !entry || receipt.accepted?.nativeInstanceId !== String(getAgentEventLifecycleGeneration())) reject("unknown");
    receipt.phase = "running";
    receipt.releasedAtMs = Date.now();
  }, true);
  if (entry && !entry.started) {
    entry.started = true;
    entry.current.receipt = receipt;
    entry.resolve();
    for (const waiter of entry.current.releaseWaiters.splice(0)) waiter.resolve();
  }
  return { worldInvestigation: receipt };
}
const noExecutionDimensions = new Set(["steps", "sourceReads", "rows", "bytes", "modelCalls", "inputTokens", "outputTokens"]);
function hasNoMatchaWorldExecution(receipt) {
  if (receipt.accepted !== null || receipt.inputDelivery !== "not_started" || receipt.pendingIo !== 0 || !Array.isArray(receipt.facts?.io) || receipt.facts.io.length !== 0) return false;
  for (const [name, values] of [["actual", receipt.facts.actual], ["reserved", receipt.facts.reserved]]) {
    if (!values || Object.getPrototypeOf(values) !== Object.prototype) return false;
    for (const [key, value] of Object.entries(values)) {
      if (name === "actual" && key === "elapsed") { u64(value); continue; }
      if (!noExecutionDimensions.has(key) || value !== "0") return false;
    }
  }
  return true;
}
function isMatchaWorldNotStartedTerminal(receipt) {
  return hasNoMatchaWorldExecution(receipt) && receipt.phase === "terminal" && receipt.childrenJoined === true && receipt.facts.nativeStopped === true && receipt.facts.ownershipConfirmed === true && receipt.facts.ownership === "native_exclusive" && receipt.facts.inputScope === "whole_input" && receipt.facts.coverage === "unknown" && receipt.usage?.kind === "unavailable" && ["failed", "cancelled", "interrupted"].includes(receipt.facts.terminal?.status);
}
export function settleMatchaWorldInvestigation(params) {
  if (typeof params.requestDigest !== "string" || !Number.isSafeInteger(params.settledAtMs) || params.settledAtMs < 0 || params.settledAtMs > Date.now()) reject("invalid_input");
  const receipt = mutate(params, receipt => {
    if (receipt.accepted === null) {
      if (params.correlation !== undefined || !isMatchaWorldNotStartedTerminal(receipt) || hash(requestBytes(receipt.acceptedParams)) !== receipt.requestDigest) reject("unknown");
    } else {
      assertExact(receipt, params, true);
      if (!params.correlation || receipt.phase !== "terminal" || receipt.childrenJoined !== true || receipt.pendingIo !== 0 || receipt.facts.nativeStopped !== true || receipt.facts.ownershipConfirmed !== true) reject("unknown");
    }
    if (receipt.settledAtMs == null) receipt.settledAtMs = params.settledAtMs;
  });
  return { worldInvestigation: receipt };
}
export function cancelAuthorizedMatchaWorldTarget(params, supplied) {
  if (!params.agentId || !params.sessionKey || !params.sessionId || !params.runId) {
    if (supplied?.requestId !== undefined || supplied?.requestDigest !== undefined) reject("invalid_input");
    return;
  }
  const target = { ...params, requestId: params.runId };
  const found = read(target);
  if (!found) {
    if (supplied?.requestId !== undefined || supplied?.requestDigest !== undefined) reject("unknown");
    return;
  }
  if (supplied && (supplied.sessionId !== params.sessionId || supplied.requestId !== params.runId || supplied.requestDigest !== found.receipt.requestDigest)) reject("request_conflict");
  return requestMatchaWorldCancellation({ ...target, requestDigest: found.receipt.requestDigest });
}
export function requestMatchaWorldCancellation(params) {
  if (typeof params.requestDigest !== "string" || typeof params.runId !== "string") reject("invalid_input");
  const receipt = mutate(params, receipt => {
    if (receipt.cancelRequestedAtMs === null) receipt.cancelRequestedAtMs = Date.now();
    if (receipt.phase === "held") receipt.phase = "cancel_requested";
  });
  const entry = held.get(params.requestDigest);
  if (entry) {
    entry.current.receipt = receipt;
    entry.current.abort?.();
    const error = new MatchaWorldInvestigationError("cancel_requested");
    entry.current.controller.abort(error);
    entry.reject(error);
    for (const waiter of entry.current.releaseWaiters.splice(0)) waiter.reject(error);
  }
  return { worldInvestigation: receipt };
}
function finishMatchaWorldNotStarted(current, terminal) {
  const owner = current.pendingOwner;
  if (!owner?.finished || current.admission !== "closed" || current.allChildrenJoined !== true || current.toolDrainUnknown === true || !(current.dispatch === "finalized" || current.dispatch === "not_started" && current.handlerFinished) || terminal.queued !== false || terminal.acceptedMessageInjection !== false) return;
  current.receipt = mutate({ ...current.params, requestDigest: current.receipt.requestDigest }, (receipt, row, database) => {
    if (!hasNoMatchaWorldExecution(receipt) || owner.databasePath !== database.path || owner.inputId !== row.input_id || owner.messageJson !== row.message_json || owner.lifecycleGeneration !== row.lifecycle_generation || owner.lifecycleGeneration !== getAgentEventLifecycleGeneration() || row.run_id !== current.params.idempotencyKey || row.idempotency_key !== owner.idempotencyKey || row.state === "queued" && row.consumed_event_id == null || row.consumed_event_id != null && row.consumed_event_id !== row.input_id) return;
    if (canonicalMatchaWorld(receipt.acceptedParams) !== canonicalMatchaWorld(current.params) || hash(requestBytes(receipt.acceptedParams)) !== receipt.requestDigest) reject("request_conflict");
    receipt.phase = "terminal";
    receipt.facts.terminal = { ...structuredClone(terminal), status: terminal.status === "cancelled" || terminal.status === "interrupted" ? terminal.status : "failed" };
    receipt.facts.nativeStopped = true;
    receipt.facts.ownershipConfirmed = true;
    receipt.facts.terminalAtMs = Date.now();
    receipt.facts.actual.elapsed = String(Math.max(0, receipt.facts.terminalAtMs - receipt.acceptedAtMs));
    receipt.childrenJoined = true;
  });
}
export function finishMatchaWorldInvestigation(runId, terminal) {
  const current = execution.getStore();
  if (!current) return;
  if (!current.receipt.accepted) {
    finishMatchaWorldNotStarted(current, terminal);
    if (!current.responded) {
      current.respond(false, undefined, { code: "WORLD_INVESTIGATION_REJECTED", message: "World investigation attempt was not accepted", details: { kind: "start_rejected" } });
      current.responded = true;
    }
    if (current.expiryTimer) clearTimeout(current.expiryTimer);
    return;
  }
  if (current.receipt.accepted.acceptedRunId !== runId) reject("request_conflict");
  current.receipt = mutate({ ...current.params, requestDigest: current.receipt.requestDigest }, receipt => {
    receipt.phase = "terminal";
    receipt.facts.terminal = structuredClone(terminal);
    if (terminal.status === "unknown") receipt.facts.coverage = "unknown";
    receipt.facts.nativeStopped = current.allChildrenJoined === true && current.toolDrainUnknown !== true && receipt.pendingIo === 0 && terminal.queued === false && terminal.acceptedMessageInjection === false;
    receipt.facts.ownershipConfirmed = receipt.accepted.nativeAttemptId === runId && receipt.accepted.nativeInstanceId === String(getAgentEventLifecycleGeneration());
    receipt.facts.terminalAtMs = Date.now();
    receipt.facts.actual.elapsed = String(Math.max(0, receipt.facts.terminalAtMs - receipt.acceptedAtMs));
    // Cancellation ACK and a final assistant are not proof that every child joined.
    receipt.childrenJoined = current.allChildrenJoined === true && current.toolDrainUnknown !== true && receipt.pendingIo === 0;
    receipt.usage = { kind: "unavailable" };
  });
  if (current.expiryTimer) clearTimeout(current.expiryTimer);
  held.delete(current.receipt.requestDigest);
}
`;

export function patchOpenClawWorldInvestigation(openclawDir) {
  if (JSON.parse(fs.readFileSync(path.join(openclawDir, 'package.json'), 'utf8')).version !== '2026.9.3') {
    throw new Error(`${PATCH_ID}: expected OpenClaw 2026.9.3`);
  }
  const dist = path.join(openclawDir, 'dist');
  const updates = new Map();
  const target = (prefix, markers) => locateSingleJavaScriptFile(dist, prefix, markers);
  const patch = (file, transform) => updates.set(file, transform(updates.get(file) ?? fs.readFileSync(file, 'utf8')));
  const addImport = (source, names) => {
    const line = `import { ${names.join(', ')} } from "./${RUNTIME_FILE}";`;
    return source.includes(line) ? source : `${line}\n${source}`;
  };
  const maintenance = target('openclaw-agent-db-maintenance-', ['function ensureSessionPendingInputsSchema(db) {']);
  const database = target('openclaw-agent-db-', ['function runOpenClawAgentWriteTransaction(', 'function openOpenClawAgentDatabase(']);
  const readonly = target('openclaw-agent-db-readonly-', ['function withOpenClawAgentDatabaseReadOnly(']);
  const sqliteScope = target('session-accessor.sqlite-scope-', ['function resolveSqliteTranscriptScope(', 'function toDatabaseOptions(']);
  const events = target('agent-events-', ['function getAgentEventLifecycleGeneration()']);
  const runRegistry = target('agent-run-registry-', ['function getAgentRunContext(runId)', 'function getActiveAgentRunDelegatedAuthority(operationalRunInstance)']);
  const runtime = [nativeImport(database, ['runOpenClawAgentWriteTransaction', 'getOpenClawAgentDatabaseIfOpen']), nativeImport(readonly, ['withOpenClawAgentDatabaseReadOnly']), nativeImport(sqliteScope, ['resolveSqliteTranscriptScope', 'toDatabaseOptions']), nativeImport(events, ['getAgentEventLifecycleGeneration']), nativeImport(runRegistry, ['getAgentRunContext', 'getActiveAgentRunDelegatedAuthority']), RUNTIME].join('\n');
  updates.set(path.join(dist, RUNTIME_FILE), runtime);
  patch(maintenance, source => {
    source = replaceOnce(source, 'o as tableHasColumn, p as readSqliteUserVersion', 'o as tableHasColumn, s as tableHasColumns, p as readSqliteUserVersion');
    source = replaceOnce(source,
      String.raw`  consumed_event_id TEXT,\n  UNIQUE (session_id, idempotency_key),`,
      String.raw`  consumed_event_id TEXT,\n  world_investigation_json TEXT,\n  UNIQUE (session_id, idempotency_key),`);
    const ensure = '\t\tdb.exec(OPENCLAW_AGENT_SCHEMA_SQL.slice(start));\n\t\tensureColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id TEXT");';
    const previousEnsure = `${ensure}\n\t\tensureColumn(db, SESSION_PENDING_INPUTS_TABLE, "world_investigation_json TEXT");\n\t});`;
    source = replaceOnce(source, source.includes(previousEnsure) ? previousEnsure : `${ensure}\n\t});`,
      '\t\tdb.exec(OPENCLAW_AGENT_SCHEMA_SQL.slice(start));\n\t\tensurePendingInputConsumptionColumn(db);\n\t});');
    source = replaceOnce(source,
      'return hasSessionPendingInputsSchema(db) && !tableHasColumn(db, "session_pending_inputs", "consumed_event_id");',
      'return hasSessionPendingInputsSchema(db) && !tableHasColumns(db, SESSION_PENDING_INPUTS_TABLE, ["consumed_event_id", "world_investigation_json"]);');
    source = replaceOnce(source,
      'function ensurePendingInputConsumptionColumn(db) {\n\tensureColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id TEXT");\n}',
      'function ensurePendingInputConsumptionColumn(db) {\n\tensureColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id TEXT");\n\tensureColumn(db, SESSION_PENDING_INPUTS_TABLE, "world_investigation_json TEXT");\n}');
    // Consumption-only readers keep their result, but cannot certify the whole writer schema.
    source = replaceOnce(source,
      '\tif (present && !db.isTransaction) completeDatabases.add(db);',
      '\tif (present && !db.isTransaction && tableHasColumn(db, SESSION_PENDING_INPUTS_TABLE, "world_investigation_json")) completeDatabases.add(db);');
    return replaceOnce(source,
      '\t\t"session_pending_inputs.consumed_event_id",',
      '\t\t"session_pending_inputs.consumed_event_id",\n\t\t"session_pending_inputs.world_investigation_json",');
  });
  const accessor = target('session-accessor-', ['async function stageSessionPendingInput(scope, options)', 'function appendTranscriptMessageInTransaction(database, resolved, options)']);
  patch(accessor, source => {
    source = addImport(source, ['stageMatchaWorldInvestigation', 'promoteMatchaWorldInvestigation', 'bindMatchaWorldPendingOwner']);
    source = replaceOnce(source, '\t\t\t\tstate: "queued",\n\t\t\t\taccepted_at: Date.now()', '\t\t\t\tstate: "queued",\n\t\t\t\tworld_investigation_json: stageMatchaWorldInvestigation(),\n\t\t\t\taccepted_at: Date.now()');
    source = replaceOnce(source, '\t\tlet finished = false;\n\t\tconst owner = {', '\t\tconst finishMatchaWorldOwner = bindMatchaWorldPendingOwner({ inputId, sessionId: scope.sessionId, sessionKey: resolved.sessionKey, databasePath: database.path, runId: options.runId, idempotencyKey, lifecycleGeneration, messageJson });\n\t\tlet finished = false;\n\t\tconst owner = {');
    source = replaceOnce(source, '\t\t\t\t}, databaseOptions);\n\t\t\t}\n\t\t};\n\t\tregisterSessionPendingInputOwner(owner);', '\t\t\t\t}, databaseOptions);\n\t\t\t\tfinishMatchaWorldOwner();\n\t\t\t}\n\t\t};\n\t\tregisterSessionPendingInputOwner(owner);');
    source = replaceOnce(source, '\t\t\tconsumeSessionPendingInput(database, pending);', '\t\t\tif (!promoteMatchaWorldInvestigation(database, pending, anchor)) consumeSessionPendingInput(database, pending);');
    return replaceOnce(source, '\t\telse consumeSessionPendingInput(database, pending);', '\t\telse if (!promoteMatchaWorldInvestigation(database, pending, anchor)) consumeSessionPendingInput(database, pending);');
  });
  const sessions = target('sessions-', ['const ChatSendParamsSchema = closedObject({', 'const ChatAbortParamsSchema = closedObject({']);
  patch(sessions, source => {
    source = replaceOnce(source, 'const ChatSendParamsSchema = closedObject({', `const MatchaWorldDecimalSchema = Type.String({ pattern: "^(0|[1-9][0-9]*)$", maxLength: 20 });
const MatchaWorldBudgetSchema = closedObject({
  maxWallTime: MatchaWorldDecimalSchema, maxSteps: MatchaWorldDecimalSchema,
  maxSourceReads: MatchaWorldDecimalSchema, maxRows: MatchaWorldDecimalSchema,
  maxBytes: MatchaWorldDecimalSchema, maxModelCalls: MatchaWorldDecimalSchema,
  maxInputTokens: MatchaWorldDecimalSchema, maxOutputTokens: MatchaWorldDecimalSchema,
  maxCost: Type.Union([closedObject({ amount: NonEmptyString, currency: NonEmptyString }), Type.Null()]),
  deadline: Type.Union([NonEmptyString, Type.Null()])
});
const MatchaWorldInvestigationSchema = closedObject({
  version: Type.Literal(1), bindingId: NonEmptyString,
  allowedEffects: Type.Array(Type.Union(["pure", "source_read", "clock_read", "probabilistic", "external_write"].map(value => Type.Literal(value))), { uniqueItems: true }),
  budget: MatchaWorldBudgetSchema,
  issuedAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  expiresAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  producer: closedObject({ runtimeInstance: NonEmptyString, mac: NonEmptyString })
});
const ChatSendParamsSchema = closedObject({
  worldInvestigation: Type.Optional(MatchaWorldInvestigationSchema),`);
    return replaceOnce(source, 'const ChatAbortParamsSchema = closedObject({', `const ChatAbortParamsSchema = closedObject({
  sessionId: Type.Optional(NonEmptyString),
  requestId: Type.Optional(NonEmptyString),
  requestDigest: Type.Optional(NonEmptyString),`);
  });
  const send = target('chat-send-handler-', ['async function handleChatSendWithOptions(', 'function startChatDispatch(']);
  patch(send, source => {
    source = addImport(source, ['currentMatchaWorldInvestigation', 'withMatchaWorldChatSend', 'bindMatchaWorldAbort', 'deferMatchaWorldAck', 'finishMatchaWorldInvestigation', 'trackMatchaWorldChild', 'joinMatchaWorldChildren', 'recordMatchaWorldTerminal', 'beginMatchaWorldDispatch', 'closeMatchaWorldAdmission']);
    source = replaceOnce(source, '\tconst dispatch = replyDispatch.runAgentMediaTranscript(', '\tbeginMatchaWorldDispatch();\n\tconst dispatch = replyDispatch.runAgentMediaTranscript(');
    source = replaceOnce(source, '\tconst cleanupAdmittedRun = () => {\n\t\tactiveRunAbort.cleanup();', '\tconst cleanupAdmittedRun = () => {\n    if (currentMatchaWorldInvestigation() && !currentMatchaWorldInvestigation().receipt.accepted) closeMatchaWorldAdmission();\n\t\tactiveRunAbort.cleanup();');
    source = replaceOnce(source,
      'async function handleChatSendWithOptions({ params, respond, context, client, sessionMutationAuthorization, sessionMutationCommitGuard }, onAdmissionOwned, externalAuthorityAdmission, options) {',
      `async function handleChatSendWithOptions(input, onAdmissionOwned, externalAuthorityAdmission, options) {
  return withMatchaWorldChatSend(input.params, input.respond, respond => handleChatSendWithOptionsAdmitted({ ...input, respond }, onAdmissionOwned, externalAuthorityAdmission, options));
}
async function handleChatSendWithOptionsAdmitted({ params, respond, context, client, sessionMutationAuthorization, sessionMutationCommitGuard }, onAdmissionOwned, externalAuthorityAdmission, options) {`);
    source = replaceOnce(source,
      '\tconst { activeRunAbort, admittedSessionId, chatSendTraceAttributes, finishAbortedChatSend, interruptedActiveRun, lifecycleGeneration, messageInjectionTarget, restartSafeAdmission } = admitted.value;',
      '\tconst { activeRunAbort, admittedSessionId, chatSendTraceAttributes, finishAbortedChatSend, interruptedActiveRun, lifecycleGeneration, messageInjectionTarget, restartSafeAdmission } = admitted.value;\n\tbindMatchaWorldAbort(() => activeRunAbort.controller.abort(new Error("World investigation expired or cancelled")));\n\tif (currentMatchaWorldInvestigation() && (admittedSessionId !== params.sessionId || preparedSession.value.agentId !== params.agentId || sessionKey !== params.sessionKey || messageInjectionTarget)) throw new Error("World investigation native target changed");');
    source = replaceOnce(source,
      '\t\tif (entry?.sessionId && isOperatorUiClient(clientInfo) && !isInternalTextSlashCommandTurn && !normalizedRequest.value.goalOperation) {',
      '\t\tif (entry?.sessionId && (currentMatchaWorldInvestigation() || isOperatorUiClient(clientInfo)) && !isInternalTextSlashCommandTurn && !normalizedRequest.value.goalOperation) {');
    source = replaceOnce(source,
      '\t\trespond(true, ackPayload, void 0, { runId: clientRunId });',
      '\t\tif (currentMatchaWorldInvestigation()) deferMatchaWorldAck(ackPayload, respond);\n\t\telse respond(true, ackPayload, void 0, { runId: clientRunId });');
    source = replaceOnce(source,
      '\tconst handleError = async (err) => {\n\t\tconst errorMessage = String(err);',
      '\tconst handleError = async (err) => {\n    recordMatchaWorldTerminal({ status: activeRunAbort.controller.signal.aborted ? "interrupted" : "failed", error: String(err), source: "dispatch_rejection" });\n\t\tconst errorMessage = String(err);');
    source = replaceOnce(source,
      '\t\t\tconst runtimeCancelled = runtimeClassification === "cancellation";',
      '\t\t\trecordMatchaWorldTerminal({ status: runtimeClassification === "success" ? "completed" : runtimeClassification === "cancellation" ? "cancelled" : runtimeClassification === "failure" || runtimeClassification === "timeout" ? "failed" : "unknown", runtimeOutcome: runtimeOutcome ?? null, recordedOutcome: recordedOutcome ?? null, source: "native_terminal" });\n\t\t\tconst runtimeCancelled = runtimeClassification === "cancellation";');
    source = replaceOnce(source,
      '\t\t\tawait dispatchErrorLifecycle.finalize();',
      '\t\t\tif (currentMatchaWorldInvestigation() && !currentMatchaWorldInvestigation().receipt.accepted) closeMatchaWorldAdmission();\n\t\t\tawait dispatchErrorLifecycle.finalize();\n      if (currentMatchaWorldInvestigation() && !currentMatchaWorldInvestigation().receipt.accepted) closeMatchaWorldAdmission(true);\n      await joinMatchaWorldChildren();\n      finishMatchaWorldInvestigation(clientRunId, { ...(currentMatchaWorldInvestigation()?.terminal ?? { status: "unknown" }), acceptedMessageInjection, queued: queuedFollowup.isEnqueued() });');
    source = replaceOnce(source,
      '\trunWithGatewayIndependentRootWorkContinuation(async () => {\n\t\tconst admission = await beginSessionWorkAdmission({',
      '\ttrackMatchaWorldChild(() => runWithGatewayIndependentRootWorkContinuation(async () => {\n\t\tconst admission = await beginSessionWorkAdmission({');
    return replaceOnce(source,
      '\t\tparams.context.logGateway.warn(`dashboard session title generation failed: ${formatForLog(err)}`);\n\t});',
      '\t\tparams.context.logGateway.warn(`dashboard session title generation failed: ${formatForLog(err)}`);\n\t}));');
  });
  const selection = target('selection-', ['async function runAgentHarnessAttempt(params, nativeSessionRuntime)', 'function selectPreparedAgentHarness(params)']);
  patch(selection, source => {
    source = addImport(source, ['prepareMatchaWorldAttempt']);
    source = replaceOnce(source,
      '}, (prepared) => pluginAttempt.runWithHostScope(() => {',
      '}, (prepared) => pluginAttempt.runWithHostScope(() => prepareMatchaWorldAttempt(prepared, harness, selection.builtIn, () => {');
    return replaceOnce(source, '\t\t\t})));', '\t\t\t}))));');
  });
  const beforeTool = target('agent-tools.before-tool-call-', ['function wrapToolWithBeforeToolCallHook(tool, ctx, options = {})', 'const buildToolContext = (identity) => ({']);
  patch(beforeTool, source => {
    source = addImport(source, ['matchaWorldHookCorrelation', 'assertMatchaWorldTool', 'withMatchaWorldTool']);
    source = replaceOnce(source, '\t\tconst buildToolContext = (identity) => ({\n\t\t\ttoolName,', '\t\tconst buildToolContext = (identity) => ({\n\t\t\t...(matchaWorldHookCorrelation(args.ctx?.runId) ? { worldInvestigation: matchaWorldHookCorrelation(args.ctx?.runId) } : {}),\n\t\t\ttoolName,');
    source = replaceOnce(source, '\t\t\tlet preparedParams;', '\t\t\tassertMatchaWorldTool(toolName);\n\t\t\tlet preparedParams;');
    return replaceOnce(source, '\t\t\t\t\tconst invoke = () => execute(...args);', '\t\t\t\t\tconst invoke = () => withMatchaWorldTool(toolName, toolCallId, () => execute(...args));');
  });
  const core = target('agent-core-', ['async function runLoop(state, newMessages, initialConfig, signal, emit, streamFn, runtime)']);
  patch(core, source => {
    source = addImport(source, ['admitMatchaWorldStep']);
    return replaceOnce(source, '\t\twhile (hasMoreToolCalls || pendingMessages.length > 0) {', '\t\twhile (hasMoreToolCalls || pendingMessages.length > 0) {\n\t\t\tadmitMatchaWorldStep("loop");');
  });
  const provider = target('provider-transport-fetch-', ['function buildGuardedModelFetch(model, timeoutMs, options)', 'init: mergeMatchaPackageMeteringInit(baseInit),']);
  patch(provider, source => {
    source = addImport(source, ['assertMatchaWorldModelTransport', 'prepareMatchaWorldModelFetch']);
    source = replaceOnce(source, '\treturn async (input, init) => {\n\t\tlet localServiceLease;', '\treturn async (input, init) => {\n\t\tassertMatchaWorldModelTransport(model);\n\t\tlet localServiceLease;');
    source = replaceOnce(source, '\t\tlet result;\n\t\tconst fetchStartedAt = Date.now();', `\t\tconst worldModel = await prepareMatchaWorldModelFetch(model, url, guardedFetchOptions.init, async (countUrl, countInit) => {
      const counted = await fetchWithSsrFGuard({ ...guardedFetchOptions, url: countUrl, init: countInit, signal: countInit.signal });
      return buildManagedResponse(counted.response, counted.release, counted.refreshTimeout);
    });
    guardedFetchOptions.init = worldModel.init;
    if (worldModel.init?.signal) guardedFetchOptions.signal = worldModel.init.signal;
\t\tlet result;\n\t\tconst fetchStartedAt = Date.now();`);
    source = replaceOnce(source, '\t\t\tlocalServiceLease?.release();\n\t\t\tthrow remediatedError;', '\t\t\tlocalServiceLease?.release();\n\t\t\tworldModel.fail("model_fetch_failed");\n\t\t\tthrow remediatedError;');
    return replaceOnce(source, '\t\tlet response = result.response;', '\t\tlet response = worldModel.observe(result.response);');
  });
  const chat = target('chat-', ['const chatHandlers = {', 'function handleDirectExternalChatSend(options, onAdmissionOwned)']);
  patch(chat, source => {
    source = addImport(source, ['inspectMatchaWorldInvestigation', 'releaseMatchaWorldInvestigation', 'settleMatchaWorldInvestigation', 'MatchaWorldInvestigationError']);
    return replaceOnce(source, '\t"chat.send": handleDirectExternalChatSend,', `  "chat.run.getByRequest": async ({ params, respond }) => {
    try { respond(true, inspectMatchaWorldInvestigation(params)); }
    catch (error) {
      if (!(error instanceof MatchaWorldInvestigationError)) throw error;
      respond(false, undefined, { code: error.code, message: error.message, details: error.worldInvestigation });
    }
  },
  "chat.run.settleInvestigation": async ({ params, respond, sessionMutationAuthorization, sessionMutationCommitGuard }) => {
    try {
      sessionMutationCommitGuard?.();
      sessionMutationAuthorization?.assertCurrent();
      respond(true, settleMatchaWorldInvestigation(params));
    } catch (error) {
      if (!(error instanceof MatchaWorldInvestigationError)) throw error;
      respond(false, undefined, { code: error.code, message: error.message, details: error.worldInvestigation });
    }
  },
  "chat.run.releaseInvestigation": async ({ params, respond, sessionMutationAuthorization, sessionMutationCommitGuard }) => {
    try {
      sessionMutationCommitGuard?.();
      sessionMutationAuthorization?.assertCurrent();
      respond(true, releaseMatchaWorldInvestigation(params));
    } catch (error) {
      if (!(error instanceof MatchaWorldInvestigationError)) throw error;
      respond(false, undefined, { code: error.code, message: error.message, details: error.worldInvestigation });
    }
  },
\t"chat.send": handleDirectExternalChatSend,`);
  });
  const methodScopes = target('method-scopes-', ['const CORE_GATEWAY_METHOD_SPECS =', 'function listCoreGatewayHandlerMethodNames()']);
  patch(methodScopes, source => {
    // Preserve the preceding search patch's whole-file seal across this known edit.
    const stamp = source.match(/^\/\/ matcha-native-searxng-v3 sha256=([a-f0-9]{64})\n/);
    const digest = value => createHash('sha256').update(value).digest('hex');
    if (stamp && digest(source.slice(stamp[0].length)) !== stamp[1]) {
      throw new Error(`${PATCH_ID}: patched source drift: ${path.basename(methodScopes)}`);
    }
    const next = replaceOnce(source,
      '\t\t"chat.abort",\n\t\t"chat-abort",',
      '\t\t"chat.run.getByRequest",\n\t\t"chat",\n\t\t"operator.read",\n\t\t"2026.9"\n\t],\n\t[\n\t\t"chat.run.releaseInvestigation",\n\t\t"chat",\n\t\t"operator.write",\n\t\t"2026.9"\n\t],\n\t[\n\t\t"chat.run.settleInvestigation",\n\t\t"chat",\n\t\t"operator.write",\n\t\t"2026.9"\n\t],\n\t[\n\t\t"chat.abort",\n\t\t"chat-abort",');
    return stamp ? next.replace(stamp[0], `// matcha-native-searxng-v3 sha256=${digest(next.slice(stamp[0].length))}\n`) : next;
  });
  const sessionPolicy = target('session-method-policy-', ['const SESSION_TARGET_FIELDS_BY_METHOD = new Map([']);
  patch(sessionPolicy, source => {
    source = replaceOnce(source, '\t["chat.abort", ["sessionKey"]],', '\t["chat.run.getByRequest", ["sessionKey"]],\n\t["chat.run.releaseInvestigation", ["sessionKey"]],\n\t["chat.run.settleInvestigation", ["sessionKey"]],\n\t["chat.abort", ["sessionKey"]],');
    return replaceOnce(source, '\t"chat.abort",', '\t"chat.run.getByRequest",\n\t"chat.run.releaseInvestigation",\n\t"chat.run.settleInvestigation",\n\t"chat.abort",');
  });
  const ownership = target('registry-runtime-session-ownership-', ['const PLUGIN_GATEWAY_SESSION_MUTATION_METHODS =']);
  patch(ownership, source => replaceOnce(source, '\t"chat.abort",', '\t"chat.run.releaseInvestigation",\n\t"chat.run.settleInvestigation",\n\t"chat.abort",'));
  const abort = target('chat-abort-handler-', ['async function handleChatAbortRequestWithLifecycle(', 'const authorizeRunTarget = (target) => {']);
  patch(abort, source => {
    source = addImport(source, ['cancelAuthorizedMatchaWorldTarget']);
    source = replaceOnce(source, '\tconst { sessionKey: rawSessionKey, runId, preserveSideRuns } = params;', `\tconst originalRespond = respond;
  let worldCancellation;
  respond = (ok, payload, error, extra) => originalRespond(ok, ok && worldCancellation ? { ...payload, ...worldCancellation } : payload, error, extra);
\tconst { sessionKey: rawSessionKey, runId, preserveSideRuns } = params;`);
    source = replaceOnce(source, '\tif (!runId) {', '\tif ((params.requestId !== undefined || params.requestDigest !== undefined) && (!runId || !params.sessionId || !params.requestId || !params.requestDigest || params.requestId !== runId)) { respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "World cancellation requires one exact input")); return; }\n\tif (!runId) {');
    source = replaceOnce(source, '\tconst authorizeRunTarget = (target) => {', `  const commitWorldCancellation = (target = {}) => {
    sessionMutationAuthorization?.assertCurrent();
    worldCancellation = cancelAuthorizedMatchaWorldTarget({ agentId: target.agentId ?? abortAgentId, sessionKey: target.sessionKey ?? canonicalAbortSessionKey, sessionId: target.sessionId ?? params.sessionId ?? abortSessionEntry?.sessionId, runId }, params) ?? worldCancellation;
  };
\tconst authorizeRunTarget = (target) => {`);
    source = replaceOnce(source, '\t\t\twritePreRegisteredChatAbort({', '\t\t\tcommitWorldCancellation({ ...pendingChatMatch.payload, sessionKey: pendingChatMatch.sessionKey });\n\t\t\twritePreRegisteredChatAbort({');
    source = replaceOnce(source, '\t\t\twritePreRegisteredAgentAbort({', '\t\t\tcommitWorldCancellation({ ...pendingAgentPayload, sessionKey: pendingAgentMatch.sessionKey });\n\t\t\twritePreRegisteredAgentAbort({');
    source = replaceOnce(source, '\t\t\tif (!authorizeRunTarget(queued)) return;', '\t\t\tif (!authorizeRunTarget(queued)) return;\n      commitWorldCancellation(queued);');
    source = replaceOnce(source, '\tif (!authorizeRunTarget(active)) return;', '\tif (!authorizeRunTarget(active)) return;\n  commitWorldCancellation(active);');
    source = replaceOnce(source, '\t\trespondWithWorkerRuns([]);', '\t\tcommitWorldCancellation({ sessionId: workerSessionId });\n\t\trespondWithWorkerRuns([]);');
    return replaceOnce(source, '\t\tif (!workerSessionId || !asWorkerInferenceControl(context.workerEnvironmentService)?.hasInferenceForSession(workerSessionId, runId)) {', `\t\tif (!workerSessionId || !asWorkerInferenceControl(context.workerEnvironmentService)?.hasInferenceForSession(workerSessionId, runId)) {
      if (params.requestId !== undefined || params.requestDigest !== undefined) {
        if (!requester.isAdmin) { respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized")); return; }
        commitWorldCancellation({ sessionId: params.sessionId });
        respond(true, { ok: true, aborted: false, runIds: [], cancellationRequested: true });
        return;
      }`);
  });
  const abortRuntime = target('chat-abort-runtime-', ['function prepareChatSessionAbort(params, selectedRunId) {']);
  patch(abortRuntime, source => {
    source = addImport(source, ['cancelAuthorizedMatchaWorldTarget']);
    source = replaceOnce(source, '\t\tparams.onControllerTargets?.(authorizedRuns);', `\t\tparams.onControllerTargets?.(authorizedRuns);
    if (hasAuthorizedGatewayRuns) {
      params.assertCurrent?.();
      for (const target of [...authorizedRuns, ...queuedPlan.authorized, ...pendingAgent.authorizedRuns, ...pendingChat.authorizedRuns]) {
        const entry = target.entry ?? target.payload ?? target;
        cancelAuthorizedMatchaWorldTarget({ agentId: entry.agentId ?? params.agentId, sessionKey: target.sessionKey ?? entry.sessionKey ?? params.sessionKey, sessionId: entry.sessionId ?? params.sessionId, runId: target.runId });
      }
    }`);
    return replaceOnce(source, '\t\t\t\t\tsessionAbort = {\n\t\t\t\t\t\tok: true,\n\t\t\t\t\t\tvalue: {', `\t\t\t\t\tif (plan.canCascade) {
\t\t\t\t\t\tassertCurrent();
\t\t\t\t\t\tcancelAuthorizedMatchaWorldTarget({ agentId: params.agentId, sessionKey: params.sessionKey, sessionId: params.sessionId, runId: entry.runId });
\t\t\t\t\t}
\t\t\t\t\tsessionAbort = {\n\t\t\t\t\t\tok: true,\n\t\t\t\t\t\tvalue: {`);
  });
  const entryStore = target('session-accessor.sqlite-entry-store-', ['function deleteSessionEntryRows(database, sessionKey, options = {})', 'function deleteLegacySessionEntryRows(']);
  patch(entryStore, source => {
    source = addImport(source, ['assertMatchaWorldRetained']);
    source = replaceOnce(source, '\tif (!owner || !ownsInput || owner.databasePath !== database.path || owner.sessionId !== scope.sessionId || owner.sessionKey !== scope.sessionKey || row && (row.input_id !== owner.inputId || row.consumed_event_id != null || row.state !== "queued" || row.lifecycle_generation !== owner.lifecycleGeneration))', '\tconst worldRetainedConsumption = !!(row?.world_investigation_json && owner && !owner.sources && row.input_id === owner.inputId && row.consumed_event_id === row.input_id && row.message_json === owner.messageJson && row.lifecycle_generation === owner.lifecycleGeneration);\n\tif (!owner || !ownsInput || owner.databasePath !== database.path || owner.sessionId !== scope.sessionId || owner.sessionKey !== scope.sessionKey || row && (row.input_id !== owner.inputId || !worldRetainedConsumption && (row.consumed_event_id != null || row.state !== "queued") || row.lifecycle_generation !== owner.lifecycleGeneration))');
    source = replaceOnce(source, '\tif (row) assertPendingInputOwnerCurrent(owner);', '\tif (row && !worldRetainedConsumption) assertPendingInputOwnerCurrent(owner);');
    source = replaceOnce(source, '\t\talreadyPromoted: !row,', '\t\talreadyPromoted: !row || worldRetainedConsumption,');
    source = replaceOnce(source, 'function deleteSessionEntryRows(database, sessionKey, options = {}) {', 'function deleteSessionEntryRows(database, sessionKey, options = {}) {\n  assertMatchaWorldRetained(database, sessionKey);');
    source = replaceOnce(source, 'function deleteSessionPendingInputs(database, sessionKey) {', 'function deleteSessionPendingInputs(database, sessionKey) {\n  assertMatchaWorldRetained(database, sessionKey);');
    return replaceOnce(source, 'function deleteLegacySessionEntryRows(database, legacyKeys, sessionKey, options = {}) {', 'function deleteLegacySessionEntryRows(database, legacyKeys, sessionKey, options = {}) {\n  for (const key of legacyKeys) assertMatchaWorldRetained(database, key);');
  });
  const lifecycleState = target('session-accessor.sqlite-lifecycle-state-', ['function deleteSqliteSessionStateRows(database, sessionId) {']);
  patch(lifecycleState, source => replaceOnce(addImport(source, ['assertMatchaWorldRetained']),
    'function deleteSqliteSessionStateRows(database, sessionId) {',
    'function deleteSqliteSessionStateRows(database, sessionId) {\n  assertMatchaWorldRetained(database, undefined, sessionId);'));
  const dashboardTitle = target('dashboard-session-title-', ['async function maybeGenerateSessionTitle(params) {']);
  patch(dashboardTitle, source => {
    source = addImport(source, ['trackMatchaWorldChild']);
    source = replaceOnce(source, '\t\tconst generation = generateDashboardSessionTitle({', '\t\tconst generation = trackMatchaWorldChild(() => generateDashboardSessionTitle({');
    return replaceOnce(source, '\t\t\t...params.worktree ? { timeoutMs: WORKTREE_SESSION_TITLE_ATTEMPT_TIMEOUT_MS } : {}\n\t\t});', '\t\t\t...params.worktree ? { timeoutMs: WORKTREE_SESSION_TITLE_ATTEMPT_TIMEOUT_MS } : {}\n\t\t}));');
  });
  const maintenanceRun = target('run-', ['function scheduleSessionMaintenance(request, afterOwnerSettles) {']);
  patch(maintenanceRun, source => {
    source = addImport(source, ['trackMatchaWorldChild', 'assertMatchaWorldAdmissionOpen']);
    source = replaceOnce(source, 'function scheduleSessionMaintenance(request, afterOwnerSettles) {', 'function scheduleSessionMaintenance(request, afterOwnerSettles) {\n  assertMatchaWorldAdmissionOpen();');
    source = replaceOnce(source, '\towner.track(run).catch((error) => {', '\ttrackMatchaWorldChild(() => owner.track(run).catch((error) => {');
    return replaceOnce(source, '\t}).finally(() => budget.dispose());', '\t}).finally(() => budget.dispose()));');
  });
  const contextMaintenance = target('context-engine-maintenance-', ['function scheduleDeferredTurnMaintenance(params) {']);
  patch(contextMaintenance, source => {
    source = addImport(source, ['currentMatchaWorldInvestigation', 'assertMatchaWorldDeferredOwner', 'trackMatchaWorldChild', 'assertMatchaWorldAdmissionOpen']);
    source = replaceOnce(source, 'function scheduleDeferredTurnMaintenance(params) {', 'function scheduleDeferredTurnMaintenance(params) {\n  assertMatchaWorldAdmissionOpen();');
    source = replaceOnce(source, '\tif (activeRun) {\n\t\tconst supersededParams', '\tif (activeRun) {\n    assertMatchaWorldDeferredOwner(activeRun.matchaWorldOwner);\n\t\tconst supersededParams');
    source = replaceOnce(source, '\t\tpromise: trackedPromise,\n\t\trerunRequested: false,', '\t\tpromise: trackedPromise,\n    matchaWorldOwner: currentMatchaWorldInvestigation(),\n\t\trerunRequested: false,');
    return replaceOnce(source, '\treturn trackedPromise;\n}', '\treturn trackMatchaWorldChild(() => trackedPromise);\n}');
  });
  const hookHelpers = target('lifecycle-hook-helpers-', ['function runAgentHarnessLlmInputHook(params) {', 'function runAgentHarnessAgentEndHook(params) {']);
  patch(hookHelpers, source => {
    source = addImport(source, ['trackMatchaWorldChild']);
    source = replaceOnce(source, '\thookRunner.runLlmInput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {', '\ttrackMatchaWorldChild(() => hookRunner.runLlmInput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {');
    source = replaceOnce(source, '\t\tlog.warn(`llm_input hook failed: ${String(error)}`);\n\t});', '\t\tlog.warn(`llm_input hook failed: ${String(error)}`);\n\t}));');
    source = replaceOnce(source, '\thookRunner.runLlmOutput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {', '\ttrackMatchaWorldChild(() => hookRunner.runLlmOutput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {');
    source = replaceOnce(source, '\t\tlog.warn(`llm_output hook failed: ${String(error)}`);\n\t});', '\t\tlog.warn(`llm_output hook failed: ${String(error)}`);\n\t}));');
    source = replaceOnce(source, '\texecuteAgentHarnessAgentEndHook({\n\t\t...params,\n\t\tunrefTimeout: true\n\t});', '\ttrackMatchaWorldChild(() => executeAgentHarnessAgentEndHook({\n\t\t...params,\n\t\tunrefTimeout: true\n\t}));');
    return source;
  });
  const sideEffects = target('context-engine-lifecycle-', ['function createSkillExperienceReviewScheduler(deps) {']);
  patch(sideEffects, source => {
    source = addImport(source, ['createMatchaWorldDeferredChild']);
    source = replaceOnce(source, '\t\t\tpending.timer = void 0;\n\t\t\tPromise.resolve(deps.isSystemActive())', '\t\t\tpending.timer = void 0;\n      if (pending.matchaWorldChild?.expired()) { pendingBySession.delete(key); pending.matchaWorldChild.finish(); return; }\n\t\t\tPromise.resolve(deps.isSystemActive())');
    source = replaceOnce(source, '\t\t\t\t\tawait deps.runReview(pending.candidate);', '\t\t\t\t\tif (pending.matchaWorldChild) await pending.matchaWorldChild.run(() => deps.runReview(pending.candidate));\n          else await deps.runReview(pending.candidate);');
    source = replaceOnce(source, '\t\t\t\t\treviewInFlight = false;', '\t\t\t\t\treviewInFlight = false;\n          pending.matchaWorldChild?.finish();');
    source = replaceOnce(source, '\t\t\t\tif (pendingBySession.get(key) === pending && pending.generation === generation) pendingBySession.delete(key);', '\t\t\t\tif (pendingBySession.get(key) === pending && pending.generation === generation) { pendingBySession.delete(key); pending.matchaWorldChild?.finish(); }');
    source = replaceOnce(source, '\t\t\t\tpendingBySession.delete(key);\n\t\t\t\treturn;', '\t\t\t\tpendingBySession.delete(key);\n        existing.matchaWorldChild?.finish();\n\t\t\t\treturn;');
    source = replaceOnce(source, '\t\t\t\t\tpendingBySession.delete(oldest[0]);', '\t\t\t\t\tpendingBySession.delete(oldest[0]);\n          oldest[1].matchaWorldChild?.finish();');
    source = replaceOnce(source, '\t\t\tpending.candidate = candidate;', '\t\t\tpending.matchaWorldChild?.finish();\n      pending.matchaWorldChild = createMatchaWorldDeferredChild();\n\t\t\tpending.candidate = candidate;');
    return replaceOnce(source, '\t\t\tfor (const pending of pendingBySession.values()) if (pending.timer) clearTimer(pending.timer);', '\t\t\tfor (const pending of pendingBySession.values()) { if (pending.timer) clearTimer(pending.timer); pending.matchaWorldChild?.finish(); }');
  });
  const isolated = target('isolated-completion-', ['async function runCliIsolatedCompletion(params) {', 'const pending = harness.runIsolatedCompletionV2({']);
  patch(isolated, source => {
    source = addImport(source, ['assertMatchaWorldUnsupported', 'assertMatchaWorldReleased', 'awaitMatchaWorldRelease', 'assertMatchaWorldModelTransport']);
    source = replaceOnce(source, 'async function runCliIsolatedCompletion(params) {', 'async function runCliIsolatedCompletion(params) {\n  assertMatchaWorldUnsupported("isolated_cli");');
    source = replaceOnce(source, '\t\t\tconst harness = await resolveHarness(runtime);', '\t\t\tconst harness = await resolveHarness(runtime);\n      if (harness.id !== "openclaw") assertMatchaWorldUnsupported("isolated_plugin_harness");');
    source = replaceOnce(source, '\t\t\t\t\t\t\tmodelMaxTokens = model?.maxTokens;', '\t\t\t\t\t\t\tassertMatchaWorldUnsupported("isolated_harness_auth");\n\t\t\t\t\t\t\tmodelMaxTokens = model?.maxTokens;');
    source = replaceOnce(source, '\t\t\t\t\t\t\tmodelMaxTokens = authorization.model.maxTokens;', '\t\t\t\t\t\t\tawait awaitMatchaWorldRelease();\n              assertMatchaWorldModelTransport(authorization.model);\n\t\t\t\t\t\t\tmodelMaxTokens = authorization.model.maxTokens;');
    source = replaceOnce(source, '\t\t\t\t\t\tconst pending = harness.runIsolatedCompletionV2({', '\t\t\t\t\t\tassertMatchaWorldReleased();\n\t\t\t\t\t\tconst pending = harness.runIsolatedCompletionV2({');
    return replaceOnce(source, '\t\t\t\tresult = await harness.runIsolatedCompletion(prepareIsolatedHostAuthorization(harness, harnessParams));', '\t\t\t\tawait awaitMatchaWorldRelease();\n\t\t\t\tassertMatchaWorldModelTransport(authorization.model);\n\t\t\t\tresult = await harness.runIsolatedCompletion(prepareIsolatedHostAuthorization(harness, harnessParams));');
  });
  const embedded = target('embedded-agent-', ['async function runEmbeddedAgentViaCliBackend(params, dispatch) {', 'function prepareNativeSessionRuntime(runParams, harness, admission) {']);
  patch(embedded, source => {
    source = addImport(source, ['assertMatchaWorldUnsupported']);
    source = replaceOnce(source, 'async function runEmbeddedAgentViaCliBackend(params, dispatch) {', 'async function runEmbeddedAgentViaCliBackend(params, dispatch) {\n  assertMatchaWorldUnsupported("embedded_cli");');
    source = replaceOnce(source, '\tif (!admission || !pinnedHarnessId || !harness.resolveSessionRuntimeOwnership) return;', '\tif (!admission || !pinnedHarnessId || !harness.resolveSessionRuntimeOwnership) return;\n  assertMatchaWorldUnsupported("native_session_owner");');
    return replaceOnce(source, 'async function executeQueuedContextEngineCompaction(input) {', 'async function executeQueuedContextEngineCompaction(input) {\n  assertMatchaWorldUnsupported("unmetered_compaction");');
  });
  const followup = target('agent-runner.runtime-', ['function createFollowupRunner(initialDefaults) {']);
  patch(followup, source => {
    source = addImport(source, ['assertMatchaWorldRecoveryNotUnscoped', 'recordMatchaWorldToolDrain']);
    source = replaceOnce(source, '\tif (pendingToolTasks.size > 0) await drainPendingToolTasks({\n\t\ttasks: pendingToolTasks,\n\t\tonTimeout: logVerbose\n\t});', '\tif (pendingToolTasks.size > 0) recordMatchaWorldToolDrain(await drainPendingToolTasks({\n\t\ttasks: pendingToolTasks,\n\t\tonTimeout: logVerbose\n\t}));');
    return replaceOnce(source, '\tconst executeFollowup = async (queued) => {', '\tconst executeFollowup = async (queued) => {\n    assertMatchaWorldRecoveryNotUnscoped({ agentId: queued.run.agentId, sessionKey: queued.run.sessionKey, sessionId: queued.run.sessionId, requestId: queued.messageId });');
  });
  const recovery = target('main-session-restart-recovery-', ['const sourceRunId = normalizeOptionalString(params.entry.restartRecoveryDeliverySourceRunId);']);
  patch(recovery, source => replaceOnce(addImport(source, ['assertMatchaWorldRecoveryNotUnscoped']),
    '\tconst sourceRunId = normalizeOptionalString(params.entry.restartRecoveryDeliverySourceRunId);',
    '\tconst sourceRunId = normalizeOptionalString(params.entry.restartRecoveryDeliverySourceRunId);\n  assertMatchaWorldRecoveryNotUnscoped({ agentId: params.agentId, sessionKey: params.sessionKey, sessionId: params.entry.sessionId, requestId: sourceRunId });'));
  const pluginBootstrap = target('server-plugin-bootstrap-', ['function prepareGatewayPluginLoad(params) {']);
  patch(pluginBootstrap, source => replaceOnce(addImport(source, ['readMatchaWorldProjection']), 'function prepareGatewayPluginLoad(params) {', 'function prepareGatewayPluginLoad(params) {\n  if (process.env.MATCHA_WORLD_PROJECTION) readMatchaWorldProjection();'));
  const workerOwners = target('placement-turn-claim-events-', ['function bindWorkerTurnOwner(', 'function getWorkerTurnExecutionIdentityCapability(store, claim)']);
  patch(workerOwners, source => {
    source = addImport(source, ['bindMatchaWorldWorkerCancellation']);
    source = replaceOnce(source, '\tconst owners = workerTurnOwners.get(path) ?? /* @__PURE__ */ new Map();\n\tconst assertActive = () => {', `\tlet commitWorldCancellationIntent;
\ttry {
\t\tcommitWorldCancellationIntent = bindMatchaWorldWorkerCancellation(store, claim, operationalRunInstance, source, delegatedAuthority, assertRunActive);
\t} catch (error) {
\t\tscope?.release();
\t\tthrow error;
\t}
\tconst owners = workerTurnOwners.get(path) ?? /* @__PURE__ */ new Map();
\tconst assertActive = () => {`);
    return replaceOnce(source, '\tconst capability = Object.freeze({ async run(callback) {', '\tconst capability = Object.freeze({ commitWorldCancellationIntent, async run(callback) {');
  });
  const workerService = target('service-', ['function createWorkerInferenceManager(options) {', 'function createWorkerEnvironmentService(options) {']);
  patch(workerService, source => {
    source = addImport(source, ['MatchaWorldInvestigationError']);
    source = replaceOnce(source, '\tstore.recoverPending(terminalError("provider-error"));\n\tconst processFence = (entry) => {', `\tstore.recoverPending(terminalError("provider-error"));
\tconst captureWorldCancellationIntent = (claim) => {
\t\tconst capability = options.getExecutionIdentityCapability?.(claim);
\t\tif (typeof capability?.commitWorldCancellationIntent !== "function") throw new MatchaWorldInvestigationError("unknown");
\t\treturn capability.commitWorldCancellationIntent;
\t};
\tconst processFence = (entry) => {`);
    source = replaceOnce(source, '\t\tif (revalidationError) {\n\t\t\tentry.abortReason = revalidationError;\n\t\t\tentry.controller.abort();', '\t\tif (revalidationError) {\n\t\t\tentry.commitWorldCancellationIntent();\n\t\t\tentry.abortReason = revalidationError;\n\t\t\tentry.controller.abort();');
    source = replaceOnce(source, '\tconst abortEntry = (entry, reason) => {\n\t\tif (!entry.abortReason)', '\tconst abortEntry = (entry, reason) => {\n\t\tentry.commitWorldCancellationIntent();\n\t\tif (!entry.abortReason)');
    source = replaceOnce(source, '\t\tconst claim = params.identity.turnClaim;\n\t\tconst claimKey = serializeWorkerSessionTurnClaim(claim);', '\t\tconst claim = params.identity.turnClaim;\n\t\tconst commitWorldCancellationIntent = captureWorldCancellationIntent(claim);\n\t\tconst claimKey = serializeWorkerSessionTurnClaim(claim);');
    source = replaceOnce(source, '\t\tconst entry = {\n\t\t\tclaimKey,\n\t\t\tidentity: params.identity,', '\t\tconst entry = {\n\t\t\tclaimKey,\n\t\t\tcommitWorldCancellationIntent,\n\t\t\tidentity: params.identity,');
    source = replaceOnce(source, '\t\t} else try {\n\t\t\tstore.cancelPending({', '\t\t} else {\n\t\t\tcaptureWorldCancellationIntent(params.identity.turnClaim)();\n\t\t\ttry {\n\t\t\tstore.cancelPending({');
    source = replaceOnce(source, '\t\t\t\toutcome: terminalError("cancelled")\n\t\t\t});\n\t\t} catch {\n\t\t\treturn {\n\t\t\t\tok: false,\n\t\t\t\treason: "provider-error"\n\t\t\t};\n\t\t}\n\t\treturn {', '\t\t\t\toutcome: terminalError("cancelled")\n\t\t\t});\n\t\t\t} catch {\n\t\t\t\treturn {\n\t\t\t\t\tok: false,\n\t\t\t\t\treason: "provider-error"\n\t\t\t\t};\n\t\t\t}\n\t\t}\n\t\treturn {');
    return replaceOnce(source, '\tconst inference = createWorkerInferenceManager({\n\t\texecute: options.executeInference,', '\tconst inference = createWorkerInferenceManager({\n\t\tgetExecutionIdentityCapability: (claim) => options.placementStore?.getExecutionIdentityCapability?.(claim),\n\t\texecute: options.executeInference,');
  });
  // The independent worker is minified and cannot import the main-process scope.
  const worker = path.join(dist, 'worker', 'worker.mjs');
  patch(worker, source => {
    source = replaceOnce(source,
      '  consumed_event_id TEXT,\n  UNIQUE (session_id, idempotency_key),',
      '  consumed_event_id TEXT,\n  world_investigation_json TEXT,\n  UNIQUE (session_id, idempotency_key),');
    source = replaceOnce(source,
      'Ot.exec(OPENCLAW_AGENT_SCHEMA_SQL.slice(Zt)),ensureColumn(Ot,SESSION_PENDING_INPUTS_TABLE,`consumed_event_id TEXT`)',
      'Ot.exec(OPENCLAW_AGENT_SCHEMA_SQL.slice(Zt)),ensurePendingInputConsumptionColumn(Ot)');
    source = replaceOnce(source,
      'return hasSessionPendingInputsSchema(Ot)&&!tableHasColumn(Ot,`session_pending_inputs`,`consumed_event_id`)',
      'return hasSessionPendingInputsSchema(Ot)&&!tableHasColumns(Ot,SESSION_PENDING_INPUTS_TABLE,[`consumed_event_id`,`world_investigation_json`])');
    source = replaceOnce(source,
      'function ensurePendingInputConsumptionColumn(Ot){ensureColumn(Ot,SESSION_PENDING_INPUTS_TABLE,`consumed_event_id TEXT`)}',
      'function ensurePendingInputConsumptionColumn(Ot){ensureColumn(Ot,SESSION_PENDING_INPUTS_TABLE,`consumed_event_id TEXT`),ensureColumn(Ot,SESSION_PENDING_INPUTS_TABLE,`world_investigation_json TEXT`)}');
    source = replaceOnce(source,
      'return Zt&&!Ot.isTransaction&&completeDatabases.add(Ot),Zt',
      'return Zt&&!Ot.isTransaction&&tableHasColumn(Ot,SESSION_PENDING_INPUTS_TABLE,`world_investigation_json`)&&completeDatabases.add(Ot),Zt');
    source = replaceOnce(source,
      'allowedMissingColumns:[`session_pending_inputs.consumed_event_id`,',
      'allowedMissingColumns:[`session_pending_inputs.consumed_event_id`,`session_pending_inputs.world_investigation_json`,');
    const retained = `function assertMatchaWorldWorkerRetained(database, field, value) {
  if (!database.db.prepare("PRAGMA table_info(session_pending_inputs)").all().some(column => column.name === "world_investigation_json")) return;
  const query = field === "session_id" ? "SELECT world_investigation_json FROM session_pending_inputs WHERE session_id = ? AND world_investigation_json IS NOT NULL" : "SELECT world_investigation_json FROM session_pending_inputs WHERE session_key = ? AND world_investigation_json IS NOT NULL";
  if (database.db.prepare(query).all(value).some(row => JSON.parse(row.world_investigation_json).settledAtMs == null)) throw new Error("World investigation input is not settled");
}
`;
    source = replaceOnce(source, 'function deleteSqliteSessionStateRows(Ot,Zt){', `${retained}function deleteSqliteSessionStateRows(Ot,Zt){assertMatchaWorldWorkerRetained(Ot,"session_id",Zt);`);
    source = replaceOnce(source, 'function deleteSessionEntryRows(Ot,Zt,_n={}){', 'function deleteSessionEntryRows(Ot,Zt,_n={}){assertMatchaWorldWorkerRetained(Ot,"session_key",Zt);');
    source = replaceOnce(source, 'function deleteLegacySessionEntryRows(Ot,Zt,_n,Dn={}){', 'function deleteLegacySessionEntryRows(Ot,Zt,_n,Dn={}){for(const key of Zt)assertMatchaWorldWorkerRetained(Ot,"session_key",key);');
    source = replaceOnce(source, 'function deleteSessionPendingInputs(Ot,Zt){', 'function deleteSessionPendingInputs(Ot,Zt){assertMatchaWorldWorkerRetained(Ot,"session_key",Zt);');
    return replaceOnce(source, 'function consumeSessionPendingInput(Ot,Zt){', 'function consumeSessionPendingInput(Ot,Zt){if(Ot.db.prepare("PRAGMA table_info(session_pending_inputs)").all().some(column=>column.name==="world_investigation_json")&&Ot.db.prepare("SELECT world_investigation_json FROM session_pending_inputs WHERE input_id = ?").get(Zt.inputId)?.world_investigation_json)throw new Error("World input promotion requires its original atomic transcript owner");');
  });
  // All source anchors are checked before any product file is written.
  let changed = 0;
  for (const [file, source] of updates) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === source) continue;
    fs.writeFileSync(file, source);
    changed += 1;
  }
  return { status: changed ? 'applied' : 'clean', detail: `${changed} World investigation product files` };
}
