import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const PATCH = 'native-request-completion';
const read = (file) => fs.readFileSync(file, 'utf8');
const hash = (source) => createHash('sha256').update(source).digest('hex');

function replace(source, before, after) {
  const patched = source.split(after).length - 1;
  if (patched === 1) return source;
  if (patched !== 0 || source.split(before).length !== 2) throw new Error(`${PATCH}: expected one anchor: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}

function transformSealed(source, transform) {
  const seals = [];
  let body = source;
  for (;;) {
    const seal = body.match(/^\/\/ ([\w.-]+) sha256=([a-f0-9]{64})\n/);
    if (!seal) break;
    body = body.slice(seal[0].length);
    if (hash(body) !== seal[2]) throw new Error(`${PATCH}: ${seal[1]} source seal mismatch`);
    seals.push(seal[1]);
  }
  body = transform(body);
  for (const name of seals.reverse()) body = `// ${name} sha256=${hash(body)}\n${body}`;
  return body;
}

// Borrow existing process state without restoring registries or starting recovery.
const TASK_MEMORY = String.raw`
function readSessionWorkMemoryTasks(sessionKeys) {
  const records = new Map();
  for (const key of sessionKeys) for (const id of taskIdsByRelatedSessionKey.get(key) ?? []) {
    const task = tasks.get(id);
    if (task) records.set(id, task);
  }
  return records;
}
export { readSessionWorkMemoryTasks, taskMatchesRelatedSession, isTerminalTaskStatus, shouldAutoDeliverTaskTerminalUpdate };
`;

const TASK_ROWS = String.raw`
function readSessionWorkTaskRows(database, sessionKeys) {
  return executeSqliteQuerySync(database.db, getTaskRegistryKysely(database.db)
    .selectFrom("task_runs").select(TASK_RUN_SELECT_COLUMNS)
    .where((eb) => eb.or(["requester_session_key", "owner_key", "child_session_key"].map((column) => eb(column, "in", sessionKeys)))))
    .rows.map(rowToTaskRecord);
}
export { readSessionWorkTaskRows };
`;

const SUBAGENT_MEMORY = String.raw`
function readSessionWorkSubagentRuns(persisted) {
  const merged = new Map(persisted);
  for (const [runId, entry] of subagentRuns) {
    const previous = merged.get(runId);
    // Keep native live-memory precedence, but a stale unended copy cannot revive a committed end.
    if (!previous || compareSubagentRunGeneration(entry, previous) >= 0 &&
      (hasSubagentRunEnded(entry) || !hasSubagentRunEnded(previous) || isSubagentRunLive(entry) || isSubagentRunQueued(entry))) merged.set(runId, entry);
  }
  return merged;
}
export { readSessionWorkSubagentRuns, isDeliveryTerminalForRequesterSettle };
`;

const SUBAGENT_ROWS = String.raw`
function readSessionWorkSubagentRows(database) {
  const rows = executeSqliteQuerySync(database.db, getNodeSqliteKysely(database.db)
    .selectFrom("subagent_runs").selectAll().orderBy("created_at", "asc").orderBy("run_id", "asc")).rows;
  return new Map(rows.map((row) => {
    const entry = rowToSubagentRunRecord(row);
    if (!entry) throw new Error("unreadable subagent work record");
    return [entry.runId, entry];
  }));
}
export { readSessionWorkSubagentRows };
`;

const DELIVERY_ROWS = String.raw`
function readSessionWorkDeliveryRows(database, sessionKeys) {
  return executeSqliteQuerySync(database.db, deliveryQueueEntriesQuery(database, ["session"], "pending")
    .where("session_key", "in", sessionKeys)).rows.map((row) => {
      const entry = inflateDeliveryQueueRow(row);
      if (!entry) throw new Error("unreadable session delivery work record");
      return entry;
    });
}
export { readSessionWorkDeliveryRows };
`;

const EXEC_WORK = String.raw`
function hasSessionExecWork(sessionKey, agentId) {
  return [...activeExecSessions.values()].some(({ session }) => session.sessionKey === sessionKey && session.agentId === agentId);
}
export { hasSessionExecWork };
`;

// All reads run in the history handler's final synchronous response segment.
const SESSION_WORK = String.raw`
function readSessionPendingWork(params) {
  const { context, cfg, requestedKey, canonicalKey, sessionId, agentId, storePath, entry } = params;
  try {
    const current = loadSessionEntryReadOnly({ sessionKey: canonicalKey, agentId, storePath, clone: false, readConsistency: "latest" });
    if (current?.sessionId !== sessionId || entry?.lifecycleRevision !== void 0 && current?.lifecycleRevision !== entry.lifecycleRevision) return null;
    const keys = [...new Set([requestedKey, canonicalKey, ...params.storeKeys,
      scopeLegacySessionKeyToAgent({ sessionKey: canonicalKey, agentId, mainKey: cfg.session?.mainKey })].filter(Boolean))];
    const scopedKeys = keys.filter((key) => parseAgentSessionKey(key));
    const identities = [...scopedKeys, sessionId].filter(Boolean);
    const hasLocalWork = () => {
      if (resolveVisibleActiveSessionRunState({ context, requestedKey, canonicalKey, sessionId, agentId,
        defaultAgentId: params.defaultAgentId, includeTerminalPersistence: true }).active ||
        isSessionWorkAdmissionActive(storePath, [...keys, sessionId]) || hasPendingFollowupQueueWork(identities) ||
        keys.some((key) => hasSessionExecWork(key, agentId))) return true;
      for (const key of keys.filter((key) => !parseAgentSessionKey(key))) {
        const queue = getExistingFollowupQueue(key);
        if (queue && hasPendingFollowupQueueWork([key]) && [...queue.items, ...queue.inFlight, ...queue.summarySources]
          .some((item) => item.run.agentId === agentId)) return true;
      }
      const wakeTarget = resolveHeartbeatSessionKey(cfg, agentId, resolveHeartbeatConfig(cfg, agentId)).sessionKey;
      if (hasSessionEventWakeWork(agentId, keys, keys.includes(wakeTarget),
        keys.includes(wakeTarget) && resolveHeartbeatAgents(cfg).some((agent) => agent.agentId === agentId))) return true;
      // Match the heartbeat consumer's metadata-only awareness exclusion, never message text.
      if (keys.some((key) => selectAgentSystemEvents(peekSystemEventEntries(key), agentId)
        .some((event) => !isHeartbeatDeliveryAwarenessEvent(event)))) return true;
      return false;
    };
    if (hasLocalWork()) return true;
    const readWork = (database) => {
      const runs = readSessionWorkSubagentRuns(database ? readSessionWorkSubagentRows(database) : new Map());
      // Root ownership follows the native requester resolver; descendants keep their native tree.
      for (const [runId, child] of runs) if (keys.includes(child.requesterSessionKey) &&
        resolveSubagentRequesterAgentId(cfg, child) !== agentId) runs.delete(runId);
      const tree = buildSubagentRunReadIndexFromRuns({ runs });
      const children = [...new Map(keys.flatMap((key) => tree.listDescendantRunsForRequester(key))
        .map((child) => [child.runId, child])).values()];
      if (keys.some((key) => tree.hasDescendantRunAwaitingSettle(key)) || children.some((child) =>
        child.requesterSettleWake || child.queuedLaunch || child.collectorLaunchCleanupPending ||
        !isDeliveryTerminalForRequesterSettle(child) && ["pending", "in_progress"].includes(child.delivery?.status))) return true;
      const workOwners = new Map(keys.map((key) => [key, agentId]));
      for (const child of children) workOwners.set(child.childSessionKey, parseAgentSessionKey(child.childSessionKey)?.agentId);
      const workKeys = [...workOwners.keys()];
      if ([...workOwners].some(([key, owner]) => owner && hasSessionExecWork(key, owner))) return true;
      const tasks = readSessionWorkMemoryTasks(workKeys);
      // Native task mutations commit before publishing memory; fresh durable rows win over old mirrors.
      for (const task of database ? readSessionWorkTaskRows(database, workKeys) : []) tasks.set(task.taskId, task);
      if ([...tasks.values()].some((task) => task.scopeKind === "session" &&
        [...workOwners].some(([key, owner]) => owner && taskMatchesRelatedSession(task, key, owner, cfg)) &&
        (!isTerminalTaskStatus(task.status) || shouldAutoDeliverTaskTerminalUpdate(task)))) return true;
      // session_queued is a historical receipt, not custody: actual events/wakes/queues own consumption.
      return database ? readSessionWorkDeliveryRows(database, workKeys).some((delivery) =>
        workOwners.has(delivery.sessionKey) &&
        (delivery.agentId ?? parseAgentSessionKey(delivery.sessionKey)?.agentId ??
          tryResolveSessionCompatibilityOwnerAgentId(cfg, delivery.sessionKey)) === workOwners.get(delivery.sessionKey) &&
        (!keys.includes(delivery.sessionKey) || !delivery.expectedSessionId || delivery.expectedSessionId === sessionId)) : false;
    };
    const pending = withExistingOpenClawStateDatabaseReadOnly((database) => runSqliteDeferredTransactionSync(database.db, () => {
      if (!["task_runs", "subagent_runs", "delivery_queue_entries"].every((table) => tableExists(database.db, table))) {
        if (hasOpenClawStateTablesBeyondStartupCheckpoint(database.db)) throw new Error("session work tables unavailable");
        return readWork();
      }
      return readWork(database);
    })) ?? readWork();
    if (pending || hasLocalWork()) return true;
    const placement = sessionId ? context.workerSessionPlacementService?.getMany([sessionId]).get(sessionId) : void 0;
    if (placement?.turnClaim) return true;
    // Worker-local exec/task/events live in an independent STATE_DIR; Gateway has no idle proof.
    if (placement && placement.state !== "local" && placement.state !== "reclaimed" && placement.executionMode !== "remote-exec") return null;
    const latest = loadSessionEntryReadOnly({ sessionKey: canonicalKey, agentId, storePath, clone: false, readConsistency: "latest" });
    return latest?.sessionId === current?.sessionId && latest?.lifecycleRevision === current?.lifecycleRevision ? false : null;
  } catch {
    return null;
  }
}
`;

export function patchOpenClawRequests(openclawDir) {
  const pkg = JSON.parse(read(path.join(openclawDir, 'package.json')));
  if (pkg.name !== 'openclaw' || pkg.version !== '2026.9.3') throw new Error(`${PATCH}: requires openclaw@2026.9.3`);
  const dist = path.join(openclawDir, 'dist');
  const names = fs.readdirSync(dist).filter((name) => /\.(?:mjs|js)$/.test(name));
  const locate = (prefix, marker) => {
    const matches = names.filter((name) => name.startsWith(prefix) && read(path.join(dist, name)).includes(marker));
    if (matches.length !== 1) throw new Error(`${PATCH}: expected one ${prefix} target, found ${matches.length}`);
    return path.join(dist, matches[0]);
  };
  const files = {
    history: locate('chat-', 'async function handleChatHistoryRequest('),
    wake: locate('heartbeat-wake-', 'function createSessionEventWakeRuntime() {'),
    task: locate('task-registry-', 'function createTaskRecord(params) {'),
    taskStore: locate('task-registry.store.sqlite-', 'function rowToTaskRecord(row) {'),
    subagent: locate('subagent-registry-read-', 'function listDescendantRunsForRequester('),
    subagentStore: locate('subagent-registry.store.sqlite-', 'function rowToSubagentRunRecord(row) {'),
    delivery: locate('delivery-queue-sqlite-', 'function loadDeliveryQueueEntries('),
    exec: locate('bash-process-registry-', 'function getActiveBackgroundExecSessionCount() {'),
  };
  const original = new Map();
  const edits = new Map();
  const edit = (file, transform) => {
    if (!original.has(file)) original.set(file, read(file));
    edits.set(file, transformSealed(edits.get(file) ?? original.get(file), transform));
  };
  const append = (file, marker, addition) => edit(file, (source) => source.includes(marker) ? source : `${source}\n${addition}`);
  const alias = (file, name) => {
    const source = edits.get(file) ?? read(file);
    const match = source.match(new RegExp(`\\b${name}\\s+as\\s+([\\w$]+)\\b`));
    if (match) return match[1];
    if (new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source)) return name;
    throw new Error(`${PATCH}: missing export ${name} in ${path.basename(file)}`);
  };
  const addImport = (file, dependency, exported) => edit(file, (source) => {
    const imports = source.match(/^import \{ [^\n]+ \} from [^\n]+;/gm) ?? [];
    if (imports.some((line) => line.slice(line.indexOf('{') + 1, line.indexOf('}')).split(',').some((symbol) => symbol.trim().split(/\s+as\s+/).at(-1) === exported))) return source;
    const name = alias(dependency, exported);
    return `import { ${name}${name === exported ? '' : ` as ${exported}`} } from "./${path.basename(dependency)}";\n${source}`;
  });
  append(files.task, 'function readSessionWorkMemoryTasks(', TASK_MEMORY);
  append(files.taskStore, 'function readSessionWorkTaskRows(', TASK_ROWS);
  append(files.subagent, 'function readSessionWorkSubagentRuns(', SUBAGENT_MEMORY);
  append(files.subagentStore, 'function readSessionWorkSubagentRows(', SUBAGENT_ROWS);
  append(files.delivery, 'function readSessionWorkDeliveryRows(', DELIVERY_ROWS);
  append(files.exec, 'function hasSessionExecWork(', EXEC_WORK);
  edit(files.wake, (source) => {
    source = replace(source, '\treturn {\n\t\tsetSessionEventWakeHandler,', String.raw`
	function hasSessionEventWakeWork(agentId, sessionKeys, includeAgentWake, includeGlobalWake) {
		const targets = sessionKeys.map((sessionKey) => targetKey({ sessionKey, agentId }));
		if (includeAgentWake) targets.push(targetKey({ agentId }));
		if (includeGlobalWake) targets.push(GLOBAL_TARGET);
		return targets.some((key) => active.has(key) || SLOTS.some((slot) => pending.get(key)?.[slot]));
	}
	return {
		hasSessionEventWakeWork,
		setSessionEventWakeHandler,`.trimStart());
    source = replace(source, 'const { setSessionEventWakeHandler, requestSessionEventWake,', 'const { hasSessionEventWakeWork, setSessionEventWakeHandler, requestSessionEventWake,');
    return source.includes('export { hasSessionEventWakeWork };') ? source : `${source}\nexport { hasSessionEventWakeWork };\n`;
  });
  const dependencies = [
    [files.task, ['readSessionWorkMemoryTasks', 'taskMatchesRelatedSession', 'isTerminalTaskStatus', 'shouldAutoDeliverTaskTerminalUpdate']],
    [files.taskStore, ['readSessionWorkTaskRows']],
    [files.subagent, ['readSessionWorkSubagentRuns', 'buildSubagentRunReadIndexFromRuns', 'isDeliveryTerminalForRequesterSettle']],
    [files.subagentStore, ['readSessionWorkSubagentRows']],
    [files.delivery, ['readSessionWorkDeliveryRows']],
    [files.exec, ['hasSessionExecWork']],
    [files.wake, ['hasSessionEventWakeWork']],
    [locate('openclaw-state-db-readonly-', 'function withExistingOpenClawStateDatabaseReadOnly('), ['withExistingOpenClawStateDatabaseReadOnly', 'hasOpenClawStateTablesBeyondStartupCheckpoint']],
    [locate('openclaw-state-db-schema-version-', 'function tableExists('), ['tableExists']],
    [locate('sqlite-transaction-', 'function runSqliteDeferredTransactionSync('), ['runSqliteDeferredTransactionSync']],
    [locate('session-accessor.sqlite-entry-', 'function loadSessionEntryReadOnly('), ['loadSessionEntryReadOnly']],
    [locate('session-lifecycle-admission-', 'function isSessionWorkAdmissionActive('), ['isSessionWorkAdmissionActive']],
    [locate('settings-', 'function hasPendingFollowupQueueWork('), ['hasPendingFollowupQueueWork', 'getExistingFollowupQueue']],
    [locate('system-events-', 'function peekSystemEventEntries('), ['peekSystemEventEntries', 'selectAgentSystemEvents']],
    [locate('heartbeat-events-filter-', 'function isHeartbeatDeliveryAwarenessEvent('), ['isHeartbeatDeliveryAwarenessEvent']],
    [locate('heartbeat-config-', 'function resolveHeartbeatConfig('), ['resolveHeartbeatConfig', 'resolveHeartbeatAgents']],
    [locate('heartbeat-runner-session-', 'function resolveHeartbeatSessionKey('), ['resolveHeartbeatSessionKey']],
    [locate('subagent-requester-owner-', 'function resolveSubagentRequesterAgentId('), ['resolveSubagentRequesterAgentId']],
    [locate('session-key-', 'function scopeLegacySessionKeyToAgent('), ['parseAgentSessionKey']],
  ];
  for (const [file, symbols] of dependencies) for (const symbol of symbols) addImport(files.history, file, symbol);
  append(files.history, 'function readSessionPendingWork(', SESSION_WORK);
  edit(files.history, (source) => replace(source, '\tconst thinkingLevel = sessionInfo.thinkingLevel ?? sessionInfo.thinkingDefault;', '\tsessionInfo.hasPendingWork = readSessionPendingWork({ context, cfg, requestedKey: sessionKey, canonicalKey, sessionId, agentId: sessionAgentId, storePath, storeKeys, entry, defaultAgentId: compatibilityOwnerAgentId });\n\tconst thinkingLevel = sessionInfo.thinkingLevel ?? sessionInfo.thinkingDefault;'));
  const changed = [...edits].filter(([file, source]) => source !== original.get(file));
  for (const [file, source] of changed) fs.writeFileSync(file, source);
  return { status: changed.length ? 'applied' : 'clean', detail: `${PATCH}: read-only session pending work; ${changed.length} native files` };
}
