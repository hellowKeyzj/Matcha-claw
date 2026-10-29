import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const VERSION = '2026.10.8';
const PATCH = 'matcha-native-task-tools-v1';
const FACTORY_HASH = 'ebc3f7c336c1895db2668f817c5d6614442ffd34e864bc2243afdafb0c501824';
const FACTORY_START = 'function resolveOpenClawPluginToolsForOptions(params) {';
const CONTEXT = '\t\t\t...pluginToolInputs.context,\n\t\t\t...delivery ? { delivery } : {},';
const BOUND_CONTEXT = '\t\t\t...pluginToolInputs.context,\n\t\t\ttaskManagerTools: createTaskManagerTools(params.options, pluginToolInputs.context),\n\t\t\t...delivery ? { delivery } : {},';
const read = (file) => fs.readFileSync(file, 'utf8');
const digest = (source) => createHash('sha256').update(source).digest('hex');

function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`${PATCH}: expected one source anchor: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}

function locate(dir, prefix, markers) {
  const files = fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && /\.(?:mjs|js)$/.test(name))
    .map((name) => path.join(dir, name)).filter((file) => markers.every((marker) => read(file).includes(marker)));
  if (files.length !== 1) throw new Error(`${PATCH}: expected one ${prefix} source, found ${files.length}`);
  return files[0];
}

function exported(file, name) {
  const match = read(file).match(new RegExp(`\\b${name} as ([\\w$]+)\\b`));
  if (!match) throw new Error(`${PATCH}: missing native export ${name}`);
  return match[1];
}

function nativeTools({ processFile, resultFile, resultAlias, scopeFile, scopeAlias }) {
  return `// ${PATCH}:begin
function createTaskManagerTools(options, context) {
	const assertSourceCurrent = captureAgentToolSourceExecutionGuard();
	const assertCallerCurrent = captureGatewayToolCallerAssertion();
	const sessionKey = options?.runSessionKey ?? options?.agentSessionKey ?? context.sessionKey;
	const scopeKey = options?.processScopeKey ?? resolveTaskProcessScopeKey({ sessionKey, sessionId: context.sessionId, agentId: context.agentId });
	const config = () => options?.sessionConfigSource === "runtime" ? getRuntimeConfig() : options?.config ?? getRuntimeConfig();
	const subagents = () => createSubagentsTool({ agentSessionKey: sessionKey, agentId: context.agentId, config: config() });
	const result = (payload) => ({
		content: [{ type: "text", text: payload.message ?? ["Task ID: " + payload.taskId, "Status: " + payload.task.status, payload.task.output || "(no output yet)"].join("\\n") }],
		details: payload,
		...payload.success ? {} : { isError: true }
	});
	const failure = (taskId, status, message, extra) => result({ success: false, taskId, status, message, ...extra });
	const bound = (value) => {
		const output = truncateUtf8Prefix(typeof value === "string" ? value : "", 32768);
		return { output, truncated: output !== value && typeof value === "string" };
	};
	const processStatus = (details) => details.status === "running" ? "running" : typeof details.idleMs === "number" ? "finalizing" : details.exitReason === "manual-cancel" && details.status === "completed" ? "cancelled" : details.timedOut ? "timed_out" : details.status === "failed" ? "failed" : "succeeded";
	const processTask = (taskId, details) => {
		const status = processStatus(details);
		const output = bound(details.output);
		return {
			id: taskId, runtime: "openclaw", type: "local_bash", title: truncateUtf8Prefix(details.name ?? "Background command", 256), status,
			...output, truncated: output.truncated || details.truncated === true || details.totalLines > 200,
			...status === "running" || status === "finalizing" ? { progressSummary: output.output } : { terminalSummary: output.output },
			...details.exitCode !== void 0 ? { exitCode: details.exitCode } : {},
			...details.exitReason ? { exitReason: details.exitReason } : {},
			...details.exitSignal ? { exitSignal: details.exitSignal } : {}
		};
	};
	const wait = async (toolCallId, taskId, signal) => {
		const response = await subagents().execute(toolCallId, { action: "wait", runIds: [taskId], timeoutSeconds: 0 }, signal);
		return response.details?.runs?.find((run) => run.runId === taskId);
	};
	return Object.freeze(Object.fromEntries(["TaskOutput", "TaskStop"].map((name) => [name, {
		name,
		label: name === "TaskOutput" ? "Task Output" : "Task Stop",
		description: name === "TaskOutput" ? "Read bounded, non-consuming output and status for an exec sessionId or sessions_spawn runId. Agent results contain only the run-owned final answer, not its transcript." : "Request cancellation of a background exec sessionId or controlled sessions_spawn runId. Accepted cancellation is not proof of termination; inspect cancelled and status.",
		parameters: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string", minLength: 1, description: "The sessionId returned by background exec, or runId returned by sessions_spawn; not a session key, pid, or JSON task ID." } } },
		async execute(toolCallId, args, signal) {
			const assertCurrent = () => {
				signal?.throwIfAborted();
				assertSourceCurrent();
				assertCallerCurrent?.();
				options?.assertInvocationCurrent?.();
				if (getPluginRuntimeGatewayRequestScope()?.pluginId !== "task-manager") throw new ToolInputError("Native task tools require the task-manager plugin invocation scope.");
			};
			assertCurrent();
			const taskId = readToolStringParam(args, "taskId", { required: true });
			if (!sessionKey || !scopeKey) return failure(taskId, "scope_unavailable", "TaskOutput/TaskStop requires an admitted caller session.");
			const { createProcessTool } = await import(${JSON.stringify('./' + processFile)});
			assertCurrent();
			const process = createProcessTool({ scopeKey });
			const logged = await process.execute(toolCallId, { action: "log", sessionId: taskId, limit: name === "TaskOutput" ? 200 : 1 }, signal);
			assertCurrent();
			const details = logged.details;
			if (details?.sessionId === taskId) {
				if (name === "TaskOutput") return result({ success: true, taskId, task: processTask(taskId, details) });
				if (processStatus(details) !== "running") return failure(taskId, "not_running", "Background command is no longer running.", { found: true, cancelled: false, task: processTask(taskId, details) });
				assertCurrent();
				const stopped = await process.execute(toolCallId, { action: "kill", sessionId: taskId }, signal);
				assertCurrent();
				if (stopped.isError || stopped.details?.status !== "completed") return failure(taskId, "stop_failed", truncateUtf8Prefix(stopped.details?.error ?? "Background command cannot be stopped.", 1024), { found: true, accepted: false, cancelled: false });
				const after = await process.execute(toolCallId, { action: "log", sessionId: taskId, limit: 1 }, signal);
				assertCurrent();
				const cancelled = after.details?.sessionId === taskId && processStatus(after.details) === "cancelled";
				return result({ success: true, taskId, found: true, accepted: true, cancelled, status: cancelled ? "cancelled" : "stop_requested", message: cancelled ? "Background command termination confirmed." : "Termination requested; completion is not yet confirmed." });
			}
			const visible = await wait(toolCallId, taskId, signal);
			assertCurrent();
			if (!visible) return failure(taskId, "not_found", "Background execution is unavailable in the caller scope.", { found: false, cancelled: false });
			if (name === "TaskStop") {
				if (visible.status === "terminal") return failure(taskId, "not_running", "Agent execution is no longer running.", { found: true, cancelled: false });
				assertCurrent();
				const response = await subagents().execute(toolCallId, { action: "cancel", runId: taskId }, signal);
				assertCurrent();
				const stopped = response.details;
				const cancelled = stopped?.targetState?.state === "terminal" && stopped.targetState.task.status === "cancelled";
				if (response.isError || stopped?.error || !stopped?.found || !stopped.killed && !cancelled) return failure(taskId, stopped?.status ?? "stop_failed", truncateUtf8Prefix(stopped?.error ?? "Agent cancellation was not accepted.", 1024), { found: stopped?.found === true, accepted: stopped?.killed === true || cancelled, cancelled });
				return result({ success: true, taskId, found: true, accepted: true, cancelled, status: cancelled ? "cancelled" : "stop_requested", message: cancelled ? "Agent termination confirmed." : "Cancellation requested; completion is not yet confirmed." });
			}
			const prepared = await prepareSubagentRunsSnapshotForRunIds(subagentRuns, [taskId]);
			assertCurrent();
			const readRun = (runId) => {
				const current = prepared.consume((runs) => runs.get(runId));
				if (!current.ready) throw new Error("Agent execution changed while preparing its result; retry TaskOutput.");
				return current.value;
			};
			const child = readRun(taskId);
			if (!child) return failure(taskId, "not_found", "Agent execution is no longer available.");
			const { readTaskAgentResult } = await import(${JSON.stringify('./' + resultFile)}).then((module) => ({ readTaskAgentResult: module[${JSON.stringify(resultAlias)}] }));
			assertCurrent();
			const terminal = child.execution.status === "terminal" && child.pauseReason !== "sessions_yield";
			const clean = terminal ? await readTaskAgentResult(child, readRun) : void 0;
			assertCurrent();
			if (!await wait(toolCallId, taskId, signal) || clean && !clean.isCurrent()) throw new Error("Agent execution authority changed while reading its result; retry TaskOutput.");
			assertCurrent();
			const status = child.endedReason === "subagent-killed" ? "cancelled" : !terminal ? mapRun(child).status : child.execution.outcome?.status === "ok" ? "succeeded" : child.execution.outcome?.status === "timeout" ? "timed_out" : "failed";
			const output = bound(clean?.text);
			return result({ success: true, taskId, task: {
				id: taskId, runtime: "openclaw", type: "local_agent", title: truncateUtf8Prefix(child.label ?? child.taskName ?? "Background agent", 256), status, ...output,
				...terminal ? { terminalSummary: output.output } : { progressSummary: "Agent is still running; a clean final result is not yet available." },
				...child.execution.outcome?.error ? { error: truncateUtf8Prefix(child.execution.outcome.error, 1024) } : {}
			} });
		}
	}])));
}
// ${PATCH}:end
import { ${scopeAlias} as resolveTaskProcessScopeKey } from ${JSON.stringify('./' + scopeFile)};
`;
}

export function patchOpenClawTaskTools(openclawDir) {
  const pkg = JSON.parse(read(path.join(openclawDir, 'package.json')));
  if (pkg.name !== 'openclaw' || pkg.version !== VERSION) throw new Error(`${PATCH}: requires openclaw@${VERSION}`);
  const dist = path.join(openclawDir, 'dist');
  const file = locate(dist, 'openclaw-tools-', [FACTORY_START, 'function createSubagentsTool(opts = {})']);
  const processFile = locate(dist, 'bash-tools-', ['export { createExecTool, createProcessTool,']);
  const resultFile = locate(dist, 'subagent-announce-output-', ['function readSubagentRunAnnounceResult(child, readSubagentRun)']);
  const scopeFile = locate(dist, 'bash-process-scope-', ['function resolveProcessToolScopeKey(params)']);
  const block = nativeTools({ processFile: path.basename(processFile), resultFile: path.basename(resultFile), resultAlias: exported(resultFile, 'readSubagentRunAnnounceResult'), scopeFile: path.basename(scopeFile), scopeAlias: exported(scopeFile, 'resolveProcessToolScopeKey') });
  const source = read(file);
  const applied = source.includes(`// ${PATCH}:begin`);
  const restored = applied ? replace(replace(source, block, ''), BOUND_CONTEXT, CONTEXT) : source;
  const start = restored.indexOf(FACTORY_START);
  const end = restored.indexOf('\n//#endregion', start);
  if (start < 0 || end < 0 || digest(restored.slice(start, end)) !== FACTORY_HASH) throw new Error(`${PATCH}: native factory source changed`);
  if (applied) return { status: 'clean', detail: 'Scoped native TaskOutput/TaskStop definitions and factory binding verified.' };
  const next = replace(replace(source, CONTEXT, BOUND_CONTEXT), FACTORY_START, block + FACTORY_START);
  fs.writeFileSync(file, next);
  return { status: 'applied', detail: 'Bound TaskOutput/TaskStop to native process/subagents through task-manager factories.' };
}
