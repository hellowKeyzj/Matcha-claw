import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { UseElectron } from './use-electron.ability.js';
import type { IabTestSite, StressCase, StressWorker } from './iab-test-site.ability.js';

export type Identity = { endpoint: { kind: string; runtimeAdapterId: string; runtimeInstanceId: string }; agentId: string; sessionKey: string };
type Row = { title: string; listId: string; marker: string };
type Owned = { identity: Identity; prompt?: string; row?: Row; worker?: StressWorker; stoppedRunId?: string; spawnRunId?: string; view?: Record<string, unknown> };
const cases: StressCase[] = ['independent', 'fanout', 'contention', 'cancel', 'handoff', 'navigation'];
const workers: StressWorker[] = ['a', 'b', 'c', 'd'];
const caseBudgetMs = 1_200_000;
const browserTimeoutMs = 290_000;
const browserSkillPath = '~/user-data/openclaw/skills/browser-relay-skill/SKILL.md';
const browserInstructions = `网页操作只用browser；如系统要求加载技能，仅允许read ${browserSkillPath}，每run至多一次。所有browser调用，包括wait，显式外层timeoutMs=${browserTimeoutMs}；wait的request.timeoutMs也必须相同。失败即停、不重试，不用exec/HTTP或其他工具。`;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function facts(value: unknown): unknown { const projection = record(value); return projection.complete ?? record(projection.incomplete).facts; }
function list(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function tools(owned: Owned): Record<string, unknown>[] { return list(facts(owned.view?.tools)); }
function runtime(owned: Owned): Record<string, unknown> { return record(facts(owned.view?.runtime)); }
function isTerminal(owned: Owned): boolean {
  return runtime(owned).activeRunId === null && ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(runtime(owned).phase))
    && (!owned.spawnRunId || list(facts(owned.view?.items)).some(item => item.kind === 'assistantTurn' && item.runId === owned.spawnRunId));
}
function content(tool: Record<string, unknown>): Record<string, unknown>[] {
  return list(Array.isArray(tool.output) ? tool.output : record(tool.output).content);
}
function text(tool: Record<string, unknown>): string { return content(tool).map(item => String(item.text ?? '')).join('\n'); }
function payload(tool: Record<string, unknown>): Record<string, unknown> {
  for (const item of content(tool)) {
    if (typeof item.text !== 'string') continue;
    try { const parsed = record(JSON.parse(item.text)); if (Object.keys(parsed).length) return parsed; } catch { /* Snapshot text is not JSON. */ }
  }
  return record(tool.details);
}
function isToolError(tool: Record<string, unknown>): boolean {
  return tool.phase === 'failed' || tool.isError === true || record(tool.output).isError === true
    || payload(tool).ok === false || record(tool.details).ok === false;
}
function errorCode(tool: Record<string, unknown>): string {
  const result = payload(tool);
  return String(result.errorCode ?? record(result.error).code ?? record(tool.details).errorCode ?? '');
}
function action(tool: Record<string, unknown>): unknown { return record(tool.input).action; }
function isWait(tool: Record<string, unknown>): boolean { return tool.name === 'browser' && action(tool) === 'act' && record(record(tool.input).request).kind === 'wait'; }
function errorEvidence(error: unknown): unknown {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack,
    cause: error.cause === undefined ? undefined : errorEvidence(error.cause),
    errors: error instanceof AggregateError ? error.errors.map(errorEvidence) : undefined } : error;
}
function requireProof(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function matchesIdentity(value: unknown, identity: Identity): boolean {
  if (typeof value !== 'string') return false;
  try {
    const parsed = record(JSON.parse(value));
    const endpoint = record(parsed.endpoint);
    return parsed.type === 'session-identity' && parsed.agentId === identity.agentId && parsed.sessionKey === identity.sessionKey
      && endpoint.kind === identity.endpoint.kind && endpoint.runtimeAdapterId === identity.endpoint.runtimeAdapterId
      && endpoint.runtimeInstanceId === identity.endpoint.runtimeInstanceId;
  } catch { return false; }
}

export async function verifyIabStress(input: {
  electron: UseElectron;
  site: IabTestSite;
  independentAgentId: string;
  sendOnce(prompt: string, agentId: string, onSubmit: () => void): Promise<Identity>;
  load(identity: Identity): Promise<Record<string, unknown>>;
  read(path: string, body?: unknown): Promise<Record<string, unknown>>;
  verifyScreenshot(tool: Record<string, unknown>, identity: Identity, savePath: string): Promise<void>;
  save(evidence: Record<string, unknown>): Promise<void>;
}, baseUrl: string): Promise<{ identity?: Identity; settled: boolean; failures: unknown[] }> {
  requireProof(/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl), 'Stress matrix requires its own loopback test site');
  requireProof(input.independentAgentId && input.independentAgentId !== 'main', 'Independent browser verification requires a different configured agentId');
  const main = input.electron.page;
  const browser = await input.electron.connectBrowser();
  const pane = main.getByTestId('agent-sessions-pane');
  const composer = main.getByTestId('chat-composer-input');
  const send = main.locator('[data-chat-control="send"]');
  const workspace = main.locator('[data-workspace-pane="side"]');
  const failures: unknown[] = [];
  const evidence: Record<string, unknown> = { cases: {}, startedAt: Date.now(), deadlineMsPerCase: caseBudgetMs, browserTimeoutMs };
  let firstIdentity: Identity | undefined;
  let settled = true;
  const snapshot = async (): Promise<Record<string, unknown>[]> => {
    const value = await main.evaluate(async () => {
      const bridge = (window as unknown as { electron: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).electron;
      return await bridge.ipcRenderer.invoke('iab:snapshot');
    });
    requireProof(Array.isArray(record(value).tabs), 'Public IAB snapshot omitted tabs');
    return list(record(value).tabs);
  };
  const pages = (url: string) => browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed() && page.url() === url);
  const persist = () => input.save(evidence);

  for (const testCase of cases) {
    if (!settled) {
      record(evidence.cases)[testCase] = { status: 'notRun', outcome: 'notRun', startedAt: null, finishedAt: null, errors: [], reason: 'Previous case has an unknown or nonterminal owned run' };
      continue;
    }
    const startedAt = Date.now(), deadline = startedAt + caseBudgetMs, executionDeadline = deadline - 25_000;
    const result: Record<string, unknown> = { status: 'running', outcome: 'running', startedAt, deadline, releases: {}, observations: {}, monitor: [], screenshots: [], cleanup: [], errors: [] };
    record(evidence.cases)[testCase] = result;
    const owned = new Map<string, Owned>();
    const roots: Owned[] = [];
    const leaves = new Map<StressWorker, Owned>();
    const tasks = new Map<string, StressWorker>();
    const cancelledWaits = new Map<string, unknown>();
    const verifiedShots = new Set<string>();
    const monitorStates = new Map<string, string>();
    const caseFailures: unknown[] = [];
    const baselineIds = new Set<string>();
    const uiPageIds = new Set<string>();
    let unknownSubmission = false;
    let unknownSpawn = false;
    let baselineKnown = false;
    const url = (worker: StressWorker | 'coordinator') => `${baseUrl}/agent-stress/${testCase}/${worker}`;
    const paths = Object.fromEntries(workers.map(worker => [worker, `iab-stress-${testCase}-${worker}-${randomUUID()}.png`])) as Record<StressWorker, string>;
    result.savePaths = paths;
    const state = () => input.site.stressResults(testCase);
    const verifyPng = async (tool: Record<string, unknown>, entry: Owned, savePath: string) => {
      await input.verifyScreenshot(tool, entry.identity, savePath);
      verifiedShots.add(String(tool.toolCallId));
      (result.screenshots as unknown[]).push({ identity: entry.identity, toolCallId: tool.toolCallId, runId: tool.runId, savePath,
        pngReadback: true, verifiedAt: Date.now(), attachment: join(input.electron.outputDirectory, savePath), tool });
    };
    const tabAt = async (address: string) => {
      const matches = (await snapshot()).filter(tab => tab.url === address);
      requireProof(matches.length === 1, `Expected exactly one public IAB tab at ${address}, found ${matches.length}`);
      return matches[0];
    };
    const dom = async (worker: StressWorker) => {
      const matches = pages(url(worker));
      requireProof(matches.length === 1, `Expected exactly one live stress document for ${testCase}/${worker}`);
      return await matches[0].evaluate(() => ({ url: location.href, answer: (document.querySelector('#answer') as HTMLInputElement).value,
        challenge: document.querySelector('#challenge')?.textContent, document: document.querySelector('#document')?.textContent,
        gate: document.querySelector('#gate')?.textContent, result: document.querySelector('#result')?.textContent }));
    };
    const rememberRow = async (marker: string): Promise<Row> => {
      const rows = await pane.locator('button[aria-current="true"]').evaluateAll(elements => elements.map(element => ({
        title: element.getAttribute('title'), listId: element.parentElement?.parentElement?.id,
      })));
      requireProof(rows.length === 1 && rows[0].title && rows[0].listId, 'Submitted root has no unique public current session row');
      requireProof((await main.getByTestId('chat-message-stack').textContent())?.includes(marker), 'Current chat does not display the exact submitted root marker');
      return { title: rows[0].title, listId: rows[0].listId, marker };
    };
    const submit = async (task: string, worker?: StressWorker, agentId = 'main'): Promise<Owned> => {
      const marker = `IAB-STRESS-${testCase}-${randomUUID()}`;
      const prompt = `${marker}\n${task}`;
      result.pendingPrompt = prompt;
      await persist();
      const identity = await input.sendOnce(prompt, agentId, () => { unknownSubmission = true; });
      const entry: Owned = { identity, prompt, worker };
      requireProof(identity.agentId === agentId, 'Browser task was submitted to a different Agent than requested');
      requireProof(!owned.has(identity.sessionKey), 'A new root send reused an existing matrix session');
      owned.set(identity.sessionKey, entry);
      roots.push(entry);
      firstIdentity ??= identity;
      unknownSubmission = false;
      entry.view = await input.load(identity);
      requireProof(list(facts(entry.view.items)).filter(item => item.kind === 'userMessage' && item.text === prompt).length === 1, 'Root send lacks its exact single persisted user message');
      entry.row = await rememberRow(marker);
      return entry;
    };
    const selectRoot = async (entry: Owned) => {
      requireProof(entry.row && entry.prompt, 'UI operation lacks an owned root row and prompt');
      const row = pane.locator(`[id=${JSON.stringify(entry.row.listId)}] button[title=${JSON.stringify(entry.row.title)}]`);
      requireProof(await row.count() === 1, 'Owned root row changed or became ambiguous; do not guess a session title');
      await row.click({ timeout: Math.max(1, Math.min(5_000, deadline - Date.now())) });
      const end = Math.min(deadline, Date.now() + 5_000);
      let selected = false;
      while (Date.now() < end) {
        selected = await row.getAttribute('aria-current') === 'true' && await pane.locator('button[aria-current="true"]').count() === 1
          && Boolean((await main.getByTestId('chat-message-stack').textContent())?.includes(entry.row.marker));
        if (selected) break;
        await delay(250);
      }
      requireProof(selected, 'Exact owned root UI selection was not confirmed');
      entry.view = await input.load(entry.identity);
      requireProof(isDeepStrictEqual(entry.view.identity, entry.identity)
        && list(facts(entry.view.items)).filter(item => item.kind === 'userMessage' && item.text === entry.prompt).length === 1, 'Selected row did not retain the exact public root identity and prompt');
    };
    const waitPolls = async (worker: StressWorker) => {
      const matches = pages(url(worker));
      return matches.length === 1 ? Number(await matches[0].locator('#wait-polls').textContent()) : 0;
    };
    const isCancelledWait = (tool: Record<string, unknown>) => isWait(tool) && typeof tool.runId === 'string'
      && cancelledWaits.has(String(tool.toolCallId)) && cancelledWaits.get(String(tool.toolCallId)) === tool.runId;
    const allowedError = (entry: Owned, tool: Record<string, unknown>) => {
      if (testCase === 'contention' && entry === leaves.get('b') && action(tool) === 'snapshot'
        && errorCode(tool) === 'IAB_AGENT_ACCESS_DENIED' && payload(tool).ok === false) return true;
      return isCancelledWait(tool) && (!errorCode(tool) || /(?:CANCEL|ABORT|REVOK|STALE|DRAIN|EPOCH)/.test(errorCode(tool)));
    };
    const toolAuthorization = (entry: Owned, tool: Record<string, unknown>): 'pending' | 'allowed' | 'denied' => {
      if (tool.name === null) return 'pending';
      if (tool.name !== 'browser' && tool.name !== 'read' && !(tool.name === 'sessions_spawn' && roots.includes(entry) && tasks.size > 0)) return 'denied';
      // Native result phase and invocation arguments are projected independently.
      if (tool.input === null) return 'pending';
      if (tool.name === 'read') return record(tool.input).path === browserSkillPath ? 'allowed' : 'denied';
      if (tool.name === 'sessions_spawn') return tasks.has(String(record(tool.input).taskName)) ? 'allowed' : 'denied';
      return 'allowed';
    };
    const discover = () => {
      unknownSpawn = false;
      for (const root of owned.values()) for (const tool of tools(root)) {
        if (tool.name === null && roots.includes(root) && tasks.size > 0) { unknownSpawn = true; continue; }
        if (tool.name !== 'sessions_spawn') continue;
        if (tool.phase === 'started' || tool.phase === 'updated') { unknownSpawn = true; continue; }
        if (tool.phase !== 'completed' || isToolError(tool)) continue;
        const receipt = payload(tool);
        if (receipt.status !== 'accepted' || typeof receipt.childSessionKey !== 'string' || typeof receipt.runId !== 'string') {
          unknownSpawn = true;
          if (tool.output === null && tool.details === null) continue;
          throw new Error('Native spawn omitted its exact accepted childSessionKey/runId; child ownership is unknown');
        }
        requireProof(roots.includes(root) && receipt.childSessionKey !== root.identity.sessionKey, 'Root spawned an unauthorized or non-child task');
        let leaf = owned.get(receipt.childSessionKey);
        if (!leaf) {
          leaf = { identity: { ...root.identity, sessionKey: receipt.childSessionKey }, spawnRunId: receipt.runId };
          owned.set(receipt.childSessionKey, leaf);
        }
        if (toolAuthorization(root, tool) === 'pending') { unknownSpawn = true; continue; }
        const worker = tasks.get(String(record(tool.input).taskName));
        requireProof(worker, 'Root spawned an unauthorized task');
        requireProof(!leaves.has(worker) || leaves.get(worker) === leaf, 'Root spawned the same worker more than once');
        requireProof(leaf.spawnRunId === receipt.runId, 'Accepted child run identity changed');
        leaf.worker = worker;
        leaves.set(worker, leaf);
      }
    };
    const refresh = async () => {
      for (const entry of owned.values()) entry.view = await input.load(entry.identity);
      discover();
      for (const entry of owned.values()) if (!entry.view) entry.view = await input.load(entry.identity);
      const errors: unknown[] = [];
      const site = state();
      for (const entry of owned.values()) {
        const status = runtime(entry), calls = tools(entry), lastTool = calls.at(-1);
        requireProof(typeof status.phase === 'string' && Object.hasOwn(status, 'activeRunId'), 'Session monitor lost native runtime facts');
        const observed = { identity: entry.identity, phase: status.phase, activeRunId: status.activeRunId, issue: status.issue,
          toolCount: calls.length, toolCallId: lastTool?.toolCallId, toolRunId: lastTool?.runId, toolPhase: lastTool?.phase,
          readyCount: entry.worker ? site.workers[entry.worker].readyCount : null,
          completedCount: entry.worker ? site.workers[entry.worker].completedCount : null };
        const signature = JSON.stringify(observed);
        if (monitorStates.get(entry.identity.sessionKey) !== signature) {
          monitorStates.set(entry.identity.sessionKey, signature);
          (result.monitor as unknown[]).push({ at: Date.now(), ...observed });
        }
        const expectedStop = entry.stoppedRunId !== undefined && isTerminal(entry)
          && ['cancelled', 'interrupted'].includes(String(status.phase))
          && list(facts(entry.view?.items)).filter(item => item.kind === 'assistantTurn').at(-1)?.runId === entry.stoppedRunId
          && calls.some(tool => isCancelledWait(tool) && tool.runId === entry.stoppedRunId);
        const expectedDenial = testCase === 'contention' && entry === leaves.get('b') && calls.some(tool => allowedError(entry, tool));
        if (!expectedStop && !expectedDenial && (status.issue !== null && status.issue !== undefined || status.errorDetail !== null && status.errorDetail !== undefined)) {
          errors.push(Object.assign(new Error(`Owned stress Agent runtime failed: ${entry.identity.sessionKey}/${String(status.issue)}`), { cause: status }));
        }
        if (record(runtime(entry).runProgress).kind === 'retrying') errors.push(new Error(`Owned stress Agent entered an unauthorized model retry: ${entry.identity.sessionKey}`));
        if (runtime(entry).phase === 'waiting_for_approval') errors.push(new Error(`Owned stress Agent requires approval: ${entry.identity.sessionKey}`));
        for (const tool of calls) {
          const authorization = toolAuthorization(entry, tool);
          if (authorization === 'denied') errors.push(new Error(`Unauthorized native tool: ${entry.identity.sessionKey}/${String(tool.toolCallId)} ${String(tool.name)}`));
          if (authorization !== 'pending' && isToolError(tool) && !allowedError(entry, tool)) errors.push(Object.assign(new Error(`Unexpected native tool failure: ${entry.identity.sessionKey}/${String(tool.toolCallId)} ${text(tool)}`), { cause: tool }));
        }
        if (isTerminal(entry) && runtime(entry).phase === 'completed'
          && !(entry.worker ? site.workers[entry.worker].completedCount === 1
            || testCase === 'contention' && entry === leaves.get('b') && tools(entry).some(tool => allowedError(entry, tool)) : site.finished)) {
          errors.push(new Error(`Owned stress Agent ended before its webpage task completed: ${entry.identity.sessionKey}`));
        }
        if (isTerminal(entry) && ['failed', 'interrupted', 'cancelled'].includes(String(runtime(entry).phase))
          && !expectedStop
          && !(testCase === 'contention' && entry === leaves.get('b') && tools(entry).some(tool => allowedError(entry, tool)))) errors.push(new Error(`Unexpected terminal phase: ${entry.identity.sessionKey}/${String(runtime(entry).phase)}`));
      }
      result.owned = [...owned.values()];
      result.site = site;
      await persist();
      if (errors.length) throw new AggregateError(errors, 'Native stress observation failed');
    };
    async function observeUntil(check: () => Promise<boolean>, message: string, end = executionDeadline): Promise<void> {
      while (Date.now() < end) {
        await refresh();
        if (!unknownSpawn && [...owned.values()].every(entry => tools(entry).every(tool => toolAuthorization(entry, tool) === 'allowed'))
          && await check()) return;
        await delay(Math.min(600, Math.max(1, end - Date.now())));
      }
      throw new Error(`${testCase}: ${message}; bounded deadline reached, never resend`);
    }
    const activeWait = (entry: Owned) => {
      const matches = tools(entry).filter(tool => isWait(tool) && tool.phase === 'started' && tool.runId === runtime(entry).activeRunId
        && record(record(tool.input).request).fn === 'window.iabStressWait()' && record(record(tool.input).request).timeMs === undefined);
      requireProof(matches.length === 1 && !isTerminal(entry), 'Ready POST did not overlap a genuinely started native browser wait');
      const budget = Number(record(record(matches[0].input).request).timeoutMs ?? record(matches[0].input).timeoutMs);
      requireProof(budget === browserTimeoutMs && record(matches[0].input).timeoutMs === browserTimeoutMs, 'Native wait omitted its bounded case budget');
      return matches[0];
    };
    const waitReady = async (entry: Owned, worker: StressWorker) => {
      await observeUntil(async () => state().workers[worker].readyAt !== null && tools(entry).some(tool => isWait(tool) && tool.phase === 'started')
        && await waitPolls(worker) >= 2, `${worker} never entered its real ready/wait barrier`);
      const wait = activeWait(entry);
      requireProof(Number(record(record(wait.input).request).timeoutMs ?? record(wait.input).timeoutMs) < executionDeadline - Date.now(), 'Started browser wait exceeds the remaining case deadline');
      const tab = await tabAt(url(worker));
      const document = await dom(worker);
      requireProof(document.answer === input.site.stressChallenge(testCase, worker) && document.challenge === document.answer
        && document.gate === '等待放行' && state().workers[worker].readyCount === 1 && state().workers[worker].completedCount === 0,
      'Independent ready document or POST count is invalid');
      requireProof(matchesIdentity(tab.claimedBy, entry.identity) && roots.some(root => matchesIdentity(tab.sessionGroupId, root.identity)), 'Ready page ownership does not match its exact native executor and root lineage');
      const observed = { at: Date.now(), tab, document, wait, waitPolls: await waitPolls(worker), runtime: runtime(entry), state: state().workers[worker] };
      record(result.observations)[`${worker}Ready`] = observed;
      return observed;
    };
    const release = (worker: StressWorker) => {
      const before = Date.now();
      input.site.releaseStress(testCase, worker);
      record(result.releases)[worker] = { before, after: Date.now(), state: state().workers[worker] };
    };
    const waitCompleted = (entry: Owned) => observeUntil(async () => isTerminal(entry), 'Owned native run did not become terminal');
    const workerPrompt = (worker: StressWorker, options: { target?: string; retain?: boolean; navigation?: boolean; preface?: string } = {}) => {
      const opening = options.target ? `直接操作本次已存在的用户页targetId=${JSON.stringify(options.target)}；不要open、navigate或关闭该页。`
        : `browser open ${url(worker)}，retain=${options.retain === true}，只操作其返回的targetId。`;
      return `${browserInstructions}${options.preface ?? ''}先browser status确认profile=iab、driver=electron，不符即停止。${opening}snapshot读取页面验证码与文档代际，用type逐字输入“输入页面验证码”，click“登记就绪”。必须立即browser act request={kind:"wait",fn:"window.iabStressWait()",timeoutMs:${browserTimeoutMs}}，外层timeoutMs=${browserTimeoutMs}；只能在${executionDeadline - browserTimeoutMs}之前开始此wait，否则报告超出预算并停止。等成功后snapshot取当前refs。${options.navigation ? `然后navigate到${url(worker)}?document=next；snapshot重新读验证码/代际；utility request={kind:"reload"}；再次snapshot重新取得refs与代际，重新type页面当前验证码，click“登记就绪”；再snapshot。` : ''}screenshot type=png savePath=${JSON.stringify(paths[worker])}，必须保存成功；click“提交结果”，snapshot确认“验证通过”。${options.navigation ? '最后仅close自己的非retain页面。' : '不要关闭页面。'}最后报告实际验证码和文档代际，不提前final，不改配置。`;
    };
    const spawnSpec = (worker: StressWorker, task: string) => {
      const taskName = `iab-${testCase}-${worker}`;
      tasks.set(taskName, worker);
      return `${worker.toUpperCase()}=${JSON.stringify({ taskName, task })}`;
    };
    const coordinatorPrompt = (instructions: string) => `${browserInstructions}另允许sessions_spawn，不重派。先browser status确认profile=iab、driver=electron；browser open ${url('coordinator')} retain=false，只操作协调页，不操作worker页。${instructions}每次sessions_spawn必须agentId=main、runtime=subagent、mode=run、cleanup=keep、expectsCompletionMessage=false、runTimeoutSeconds=1140，不改模型。A/B/C/D等号后的JSON对象给出taskName和task，原样传入sessions_spawn；taskName是本轮固定任务标识，禁止用label替代；保留childSessionKey/runId。子任务为quiet模式，不会发送完成通知，不用sessions_yield或轮询子会话；协调页“全部完成”只在验收方核实所有子任务终态与真实结果后出现。最后在自己的协调页browser act request={kind:"wait",text:"全部完成",timeoutMs:${browserTimeoutMs}}，外层timeoutMs=${browserTimeoutMs}，只能在${executionDeadline - browserTimeoutMs}之前开始此wait，否则停止报告超预算。必须等“全部完成”再snapshot确认，汇总协调页实际结果，不提前final、不追加任务。`;
    const verifyCalls = (entry: Owned) => {
      requireProof(entry.view && isTerminal(entry), 'Final verification requires a terminal owned session');
      for (const key of ['items', 'tools', 'runtime', 'window']) {
        const projection = record(entry.view[key]), incomplete = record(projection.incomplete);
        const allowedGaps = key === 'runtime' ? ['partial_runtime', 'event_only'] : ['bounded_history', 'event_only'];
        requireProof(Object.hasOwn(projection, 'complete') || Object.hasOwn(incomplete, 'facts')
          && Array.isArray(incomplete.gaps) && incomplete.gaps.every(gap => allowedGaps.includes(String(gap))), `Final ${key} projection has unknown or missing native facts`);
      }
      const items = facts(entry.view.items), window = record(facts(entry.view.window));
      requireProof(Array.isArray(items) && Array.isArray(facts(entry.view.tools)) && window.hasMore === false && window.hasNewer === false
        && window.isAtLatest === true && window.windowStartOffset === 0 && window.windowEndOffset === window.totalItemCount
        && Number.isSafeInteger(window.totalItemCount) && Number(window.totalItemCount) > 0, 'Final native source window is truncated or not at latest');
      const turns = list(items).filter(item => item.kind === 'assistantTurn');
      const calls = tools(entry);
      requireProof(calls.length > 0 && new Set(calls.map(tool => tool.toolCallId)).size === calls.length, 'Native tool receipts are absent or duplicated');
      const reads = calls.filter(tool => tool.name === 'read');
      requireProof(new Set(reads.map(tool => tool.runId)).size === reads.length, 'Browser skill was read more than once in the same run');
      for (const tool of calls) {
        requireProof(toolAuthorization(entry, tool) === 'allowed' && typeof tool.toolCallId === 'string' && typeof tool.runId === 'string'
          && turns.some(turn => turn.runId === tool.runId), 'Tool receipt lacks complete authorized invocation facts or exact native assistant run identity');
        requireProof(tool.phase === 'completed' || allowedError(entry, tool) && tool.phase === 'failed'
          || isCancelledWait(tool) && tool.phase === 'started' && tool.output === null, 'Final native tool receipt remains unsettled');
        if (tool.name === 'browser') requireProof(record(tool.input).timeoutMs === browserTimeoutMs, 'Browser invocation did not use its explicit bounded timeout');
        if (tool.name === 'sessions_spawn') requireProof(record(tool.input).expectsCompletionMessage === false
          && record(tool.input).runTimeoutSeconds === 1140 && record(tool.input).model === undefined, 'Coordinator did not preserve the bounded quiet native child contract');
        requireProof(!isToolError(tool) || allowedError(entry, tool), 'Unexpected native error in final transcript');
      }
      if (entry.spawnRunId) requireProof(calls.every(tool => tool.runId === entry.spawnRunId), 'Child calls do not match accepted native spawn runId');
      const status = calls.find(tool => tool.name === 'browser' && action(tool) === 'status');
      if (!(testCase === 'contention' && entry === leaves.get('b'))) requireProof(status && /"profile"\s*:\s*"iab"/.test(text(status))
        && /"driver"\s*:\s*"electron"/.test(text(status)), 'Native browser status did not prove IAB/electron');
    };
    const verifyWorker = async (entry: Owned, worker: StressWorker, address = url(worker)) => {
      verifyCalls(entry);
      const calls = tools(entry);
      const target = record(result.observations)[`${worker}Ready`];
      const targetId = record(record(target).tab).id;
      requireProof(typeof targetId === 'string' && calls.every(tool => {
        const params = record(tool.input), nested = record(params.request);
        return (params.targetId === undefined || params.targetId === targetId) && (nested.targetId === undefined || nested.targetId === targetId)
          && (params.url === undefined || params.url === address || testCase === 'navigation' && params.url === `${address}?document=next`);
      }), 'Worker crossed its exact target or loopback URL boundary');
      if (!(testCase === 'contention')) {
        const open = calls.filter(tool => action(tool) === 'open' && record(tool.input).url === address);
        requireProof(open.length === 1 && payload(open[0]).targetId === targetId, 'Worker open receipt does not identify its independently observed native target');
      }
      const shots = calls.filter(tool => action(tool) === 'screenshot');
      requireProof(shots.length === 1 && record(shots[0].input).savePath === paths[worker]
        && content(shots[0]).some(item => item.type === 'image' && item.mimeType === 'image/png'), 'Worker omitted its exact unique PNG receipt');
      await verifyPng(shots[0], entry, paths[worker]);
      const outcome = state().workers[worker];
      requireProof(outcome.completedCount === 1 && outcome.answer === input.site.stressChallenge(testCase, worker)
        && outcome.events.filter(event => event.action === 'complete').every(event => event.answer === outcome.answer)
        && outcome.completedAt !== null && outcome.completedAt >= Number(record(record(result.releases)[worker]).before), 'Independent native webpage POST did not prove exactly one released completion');
      record(result.observations)[`${worker}Verified`] = { targetId, screenshot: shots[0], pngReadback: true, state: outcome };
    };
    const stop = async (entry: Owned, wait: Record<string, unknown>) => {
      await selectRoot(entry);
      requireProof(await waitPolls('a') >= 2, 'UI Stop requires independently observed live browser wait polling');
      requireProof(runtime(entry).activeRunId === wait.runId && tools(entry).some(tool => tool.toolCallId === wait.toolCallId && tool.phase === 'started'), 'UI Stop target is no longer the exact waiting run');
      requireProof(/^(停止|Stop)$/.test(await send.getAttribute('aria-label') ?? ''), 'Exact owned session has no business UI Stop button');
      cancelledWaits.set(String(wait.toolCallId), wait.runId);
      entry.stoppedRunId = String(wait.runId);
      record(result.observations).stop = { identity: entry.identity, runId: wait.runId, toolCallId: wait.toolCallId, before: Date.now(), row: entry.row };
      await send.click({ timeout: 5_000 });
      await waitCompleted(entry);
      requireProof(['cancelled', 'interrupted'].includes(String(runtime(entry).phase)), 'UI Stop did not produce a cancelled/interrupted terminal run');
      record(result.observations).stopped = { at: Date.now(), view: entry.view,
        waitReceipt: tools(entry).find(tool => tool.toolCallId === wait.toolCallId && tool.runId === wait.runId) };
    };
    const compareWaiting = async (entry: Owned, worker: StressWorker, before: Awaited<ReturnType<typeof waitReady>>) => {
      await refresh();
      const current = await tabAt(url(worker));
      requireProof(activeWait(entry).toolCallId === before.wait.toolCallId && runtime(entry).activeRunId === before.runtime.activeRunId
        && await waitPolls(worker) > before.waitPolls
        && isDeepStrictEqual(await dom(worker), before.document) && isDeepStrictEqual(state().workers[worker], before.state)
        && ['id', 'createdBy', 'claimedBy', 'sessionGroupId'].every(key => current[key] === before.tab[key]), 'Sibling action changed the waiting Agent, target, input, document or native ownership');
      record(result.observations)[`${worker}Isolation`] = { at: Date.now(), tab: current, document: await dom(worker), waitPolls: await waitPolls(worker), runtime: runtime(entry), state: state().workers[worker] };
    };
    const openUserPage = async () => {
      await workspace.getByRole('button', { name: /^(打开页面|Open a page)$/ }).click();
      await observeUntil(async () => browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed() && page.url().endsWith('/iab/overlay/index.html')).length === 1, 'Workspace browser menu did not appear');
      const overlays = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed() && page.url().endsWith('/iab/overlay/index.html'));
      await overlays[0].getByRole('menuitem', { name: /^(浏览器|Browser)$/ }).click();
      const address = main.locator('[data-browser-surface]:visible').getByLabel(/^(搜索或输入网址|Search or enter a URL)$/);
      await address.fill(url('a'));
      await address.press('Enter');
      await observeUntil(async () => (await snapshot()).filter(tab => tab.url === url('a')).length === 1 && pages(url('a')).length === 1, 'Own UI-created contention page did not open');
      const tab = await tabAt(url('a'));
      requireProof(typeof tab.id === 'string' && !baselineIds.has(tab.id) && tab.createdBy === null && tab.claimedBy === null && tab.sessionGroupId === null, 'Contention page is not a new unclaimed user tab');
      uiPageIds.add(tab.id);
      result.userPage = tab;
      return tab.id;
    };

    try {
      for (const tab of await snapshot()) if (typeof tab.id === 'string') baselineIds.add(tab.id);
      baselineKnown = true;
      result.baselineTabIds = [...baselineIds];
      if (testCase === 'independent') {
        const a = await submit(workerPrompt('a'), 'a');
        const readyA = await waitReady(a, 'a');
        const b = await submit(workerPrompt('b'), 'b', input.independentAgentId);
        const readyB = await waitReady(b, 'b');
        requireProof(a.identity.agentId !== b.identity.agentId && a.identity.sessionKey !== b.identity.sessionKey
          && readyA.wait.runId !== readyB.wait.runId && readyA.tab.id !== readyB.tab.id
          && readyA.tab.sessionGroupId !== readyB.tab.sessionGroupId
          && matchesIdentity(readyA.tab.createdBy, a.identity) && matchesIdentity(readyB.tab.createdBy, b.identity),
        'Independent browser tasks must have distinct Agent IDs, sessions, native runs, targets and root ownership');
        await compareWaiting(a, 'a', readyA);
        await compareWaiting(b, 'b', readyB);
        release('a');
        await waitCompleted(a);
        await verifyWorker(a, 'a');
        await observeUntil(async () => pages(url('a')).length === 0 && !(await snapshot()).some(tab => tab.id === readyA.tab.id),
          'Independent Agent A did not clean its own temporary page');
        await compareWaiting(b, 'b', readyB);
        release('b');
        await waitCompleted(b);
        await verifyWorker(b, 'b');
      } else if (testCase === 'fanout') {
        const specs = workers.map(worker => spawnSpec(worker, workerPrompt(worker)));
        const root = await submit(coordinatorPrompt(`必须连续spawn四个独立子Agent，不等任何前者完成就全部spawn：${specs.join('；')}。全部spawn后，在自己的协调页依次执行三次不同阶段的browser act wait：先等text="全部就绪"，成功后snapshot；再等text="A已完成"，成功后snapshot；然后才进入末尾的“全部完成”等待。每次wait的request.timeoutMs与外层timeoutMs均为${browserTimeoutMs}，任一步失败即停，不重复该阶段。`));
        await observeUntil(async () => leaves.size === 4 && workers.every(worker => state().workers[worker].readyAt !== null
          && tools(leaves.get(worker)!).some(tool => isWait(tool) && tool.phase === 'started')), 'Four children did not concurrently reach the ready/wait barrier');
        const ready = new Map<StressWorker, Awaited<ReturnType<typeof waitReady>>>();
        for (const worker of workers) ready.set(worker, await waitReady(leaves.get(worker)!, worker));
        requireProof(new Set([...leaves.values()].map(leaf => leaf.identity.sessionKey)).size === 4
          && new Set([...leaves.values()].map(leaf => leaf.spawnRunId)).size === 4
          && new Set([...ready.values()].map(item => item.tab.id)).size === 4, 'Fanout children did not have four distinct sessions, runs and targets');
        const groups = new Set([...ready.values()].map(item => item.tab.sessionGroupId));
        requireProof(groups.size === 1 && [...ready.values()].every(item => item.tab.createdBy === item.tab.claimedBy)
          && new Set([...ready.values()].map(item => item.tab.claimedBy)).size === 4, 'Fanout native lineage/leaf ownership is not independent within one root');
        release('a');
        await waitCompleted(leaves.get('a')!);
        requireProof(!isTerminal(root) && pages(url('a')).length === 1, 'Leaf terminal did not preserve its page while root remained active');
        for (const worker of ['b', 'c', 'd'] as const) await compareWaiting(leaves.get(worker)!, worker, ready.get(worker)!);
        for (const worker of ['b', 'c', 'd'] as const) release(worker);
        await observeUntil(async () => [...leaves.values()].every(isTerminal), 'Fanout children did not all settle');
        for (const worker of workers) {
          requireProof(pages(url(worker)).length === 1 && !isTerminal(root), 'Root ended early or leaf terminal removed its group-owned page');
          await verifyWorker(leaves.get(worker)!, worker);
        }
        requireProof(workers.every(worker => state().workers[worker].readyAt! <= Number(record(record(result.releases).a).before)), 'Fanout release occurred before all four ready POSTs');
        input.site.finishStress(testCase);
        await waitCompleted(root);
        verifyCalls(root);
        requireProof(tools(root).filter(tool => tool.name === 'sessions_spawn').length === 4, 'Fanout did not perform exactly four native spawns');
        requireProof(isDeepStrictEqual(tools(root).filter(isWait).map(tool => record(record(tool.input).request).text),
          ['全部就绪', 'A已完成', '全部完成']), 'Coordinator did not perform exactly its three distinct bounded stage waits');
      } else if (testCase === 'contention') {
        const targetId = await openUserPage();
        const a = spawnSpec('a', workerPrompt('a', { target: targetId }));
        const bTask = `${browserInstructions}仅执行一次browser snapshot，targetId=${JSON.stringify(targetId)}，timeoutMs=${browserTimeoutMs}。这是同一root的兄弟A正在claim的用户页，必须收到IAB_AGENT_ACCESS_DENIED。不得status/tabs/open/focus/type/click，不重试、不绕过，不操作其他目标；收到后报告原始errorCode并结束。若成功或其他错误也只报告并结束，不改页面。`;
        const b = spawnSpec('b', bTask);
        const root = await submit(coordinatorPrompt(`先spawn ${a}；必须在自己的协调页browser act wait text="A已就绪" timeoutMs=${browserTimeoutMs}、外层timeoutMs=${browserTimeoutMs}，成功后才spawn ${b}。`));
        await observeUntil(async () => Boolean(leaves.get('a')) && state().workers.a.readyAt !== null && tools(leaves.get('a')!).some(tool => isWait(tool) && tool.phase === 'started'), 'Contention A did not claim the common user page');
        const ready = await waitReady(leaves.get('a')!, 'a');
        await observeUntil(async () => Boolean(leaves.get('b')) && isTerminal(leaves.get('b')!), 'Same-root contender B did not finish its one-shot claim denial');
        const childB = leaves.get('b')!;
        verifyCalls(childB);
        const calls = tools(childB).filter(tool => tool.name === 'browser');
        requireProof(calls.length === 1 && calls[0].name === 'browser' && action(calls[0]) === 'snapshot'
          && record(calls[0].input).targetId === targetId && allowedError(childB, calls[0]) && isToolError(calls[0]), 'Contender did not receive exactly the expected access-denied class on the shared target');
        const owner = await tabAt(url('a'));
        requireProof(owner.createdBy === null && owner.id === targetId && owner.claimedBy === ready.tab.claimedBy
          && owner.sessionGroupId === ready.tab.sessionGroupId && leaves.get('a')!.identity.sessionKey !== childB.identity.sessionKey,
        'Contention failed to preserve user ownership and the distinct same-root active leaf claim');
        result.expectedDenial = { identity: childB.identity, acceptedRunId: childB.spawnRunId, tool: calls[0], isError: calls[0].isError, phase: calls[0].phase,
          errorCode: errorCode(calls[0]), owner, root: root.identity };
        await compareWaiting(leaves.get('a')!, 'a', ready);
        requireProof(state().workers.b.visits === 0 && state().workers.b.events.length === 0, 'Denied contender navigated or mutated its own replacement page');
        release('a');
        await waitCompleted(leaves.get('a')!);
        await verifyWorker(leaves.get('a')!, 'a');
        requireProof((await tabAt(url('a'))).createdBy === null, 'Leaf terminal closed or recreated the common user page');
        input.site.finishStress(testCase);
        await waitCompleted(root);
        verifyCalls(root);
        requireProof(tools(root).filter(tool => tool.name === 'sessions_spawn').length === 2 && (await tabAt(url('a'))).id === targetId,
          'Root terminal did not preserve the exact common user tab');
      } else if (testCase === 'cancel') {
        const a = await submit(workerPrompt('a'), 'a');
        const readyA = await waitReady(a, 'a');
        const b = await submit(workerPrompt('b'), 'b', input.independentAgentId);
        const readyB = await waitReady(b, 'b');
        requireProof(a.identity.agentId !== b.identity.agentId && a.identity.sessionKey !== b.identity.sessionKey && readyA.wait.runId !== readyB.wait.runId
          && readyA.tab.sessionGroupId !== readyB.tab.sessionGroupId, 'Cancellation did not use two different Agents with independent concurrent roots');
        await stop(a, readyA.wait);
        await observeUntil(async () => pages(url('a')).length === 0 && !(await snapshot()).some(tab => tab.id === readyA.tab.id), 'Cancelled root did not clean its temporary page');
        verifyCalls(a);
        requireProof(state().workers.a.completedCount === 0, 'Cancelled wait wrote a forbidden completion');
        await compareWaiting(b, 'b', readyB);
        release('b');
        await waitCompleted(b);
        await verifyWorker(b, 'b');
      } else if (testCase === 'handoff') {
        const root = await submit(workerPrompt('a', { retain: true }), 'a');
        const ready = await waitReady(root, 'a');
        const newMarker = `IAB-STRESS-handoff-new-${randomUUID()}`;
        const newPrompt = `${newMarker}\n${workerPrompt('b', { retain: true,
          preface: `这是同一session的新run，不是重试。先tabs找到并snapshot旧retain页${url('a')}（只读、不提交、不改输入），然后开始自己的不同验证码任务。` })}`;
        await stop(root, ready.wait);
        await observeUntil(async () => await composer.inputValue() === '' && !/^(停止|Stop)$/.test(await send.getAttribute('aria-label') ?? ''), 'Same-session composer was not ready after UI Stop');
        root.worker = 'b';
        unknownSubmission = true;
        result.pendingPrompt = newPrompt;
        await composer.fill(newPrompt);
        requireProof(await send.isEnabled(), 'Same-session second send is unavailable; never resend');
        const newSentAt = Date.now();
        await send.click({ timeout: 5_000 });
        await observeUntil(async () => list(facts(root.view?.items)).filter(item => item.kind === 'userMessage' && item.text === newPrompt).length === 1
          && tools(root).some(tool => action(tool) === 'open' && record(tool.input).url === url('b')), 'Same-session second prompt did not acquire its exact new native run');
        unknownSubmission = false;
        const readyB = await waitReady(root, 'b');
        requireProof(pages(url('a')).length === 1 && (await tabAt(url('a'))).retained === true, 'Stopped handoff run did not retain its old page');
        requireProof(readyB.wait.runId !== ready.wait.runId && root.identity.sessionKey === record(root.view?.identity).sessionKey
          && readyB.tab.retained === true && readyB.tab.id !== ready.tab.id, 'Handoff did not use a new run on the same native session with its own retained target');
        result.handoff = { identity: root.identity, oldRunId: ready.wait.runId, newRunId: readyB.wait.runId, oldToolCallId: ready.wait.toolCallId, newSentAt, newPrompt };
        const oldPolls = await waitPolls('a'), oldDocument = await dom('a');
        await delay(1_200);
        requireProof(await waitPolls('a') === oldPolls, 'Stopped old run is still polling its retained page after the new run was admitted');
        release('a');
        await delay(Math.min(1_200, Math.max(1, executionDeadline - Date.now())));
        await compareWaiting(root, 'b', readyB);
        const releasedOldDocument = await dom('a');
        requireProof(state().workers.a.completedCount === 0 && (await tabAt(url('a'))).id === ready.tab.id
          && await waitPolls('a') === oldPolls && ['answer', 'challenge', 'document', 'result'].every(key => record(releasedOldDocument)[key] === record(oldDocument)[key]),
        'Old stopped wait resumed a forbidden completion or changed its retained document');
        record(result.observations).oldWaitDrained = { oldPolls, oldDocument, releasedOldDocument, waitPollsAfterRelease: await waitPolls('a'), at: Date.now() };
        release('b');
        await waitCompleted(root);
        verifyCalls(root);
        const oldCalls = tools(root).filter(tool => tool.runId === ready.wait.runId);
        requireProof(oldCalls.filter(tool => isWait(tool)).length === 1 && oldCalls.some(isCancelledWait)
          && state().workers.a.completedCount === 0 && state().workers.b.completedCount === 1 && pages(url('b')).length === 1,
        'Late old wait receipt mutated completion state or cleaned the new retained page');
        await observeUntil(async () => (await tabAt(url('a'))).claimedBy === null && (await tabAt(url('b'))).claimedBy === null,
          'Completed handoff root did not release both retained page claims');
        const newCalls = tools(root).filter(tool => tool.runId === readyB.wait.runId);
        const shot = newCalls.filter(tool => action(tool) === 'screenshot' && record(tool.input).savePath === paths.b);
        requireProof(shot.length === 1 && newCalls.some(tool => action(tool) === 'snapshot' && record(tool.input).targetId === ready.tab.id)
          && content(shot[0]).some(item => item.type === 'image' && item.mimeType === 'image/png'), 'Handoff new run did not reuse the retained page or save its own PNG');
        await verifyPng(shot[0], root, paths.b);
        requireProof(runtime(root).phase === 'completed' && state().workers.b.answer === input.site.stressChallenge(testCase, 'b')
          && (await dom('b')).result === '验证通过', 'Handoff new run did not complete its independent marker/code');
      } else {
        const a = await submit(workerPrompt('a', { navigation: true }), 'a');
        const readyA = await waitReady(a, 'a');
        const b = await submit(workerPrompt('b'), 'b', input.independentAgentId);
        const readyB = await waitReady(b, 'b');
        requireProof(a.identity.agentId !== b.identity.agentId && readyA.tab.sessionGroupId !== readyB.tab.sessionGroupId
          && readyA.tab.id !== readyB.tab.id, 'Navigation did not overlap two different Agents with independently owned roots');
        release('a');
        await waitCompleted(a);
        await verifyWorker(a, 'a');
        const calls = tools(a), navigate = calls.findIndex(tool => action(tool) === 'navigate' && record(tool.input).url === `${url('a')}?document=next`);
        const reload = calls.findIndex((tool, index) => index > navigate && action(tool) === 'utility' && record(record(tool.input).request).kind === 'reload');
        const close = calls.findIndex((tool, index) => index > reload && action(tool) === 'close');
        const events = state().workers.a.events, readyEvents = events.filter(event => event.action === 'ready');
        const complete = events.find(event => event.action === 'complete');
        requireProof(navigate >= 0 && reload > navigate && close > reload
          && calls.slice(navigate + 1, reload).some(tool => action(tool) === 'snapshot')
          && calls.slice(reload + 1, close).some(tool => action(tool) === 'snapshot')
          && readyEvents.length === 2 && complete && complete.document === readyEvents[1].document
          && complete.document > readyEvents[0].document && state().workers.a.visits >= complete.document
          && Number(readyA.document.document) === readyEvents[0].document,
        'Navigation/reload did not reacquire fresh refs and submit the independently observed newer document generation');
        result.navigation = { initialDocument: readyA.document, events, visits: state().workers.a.visits, navigate: calls[navigate], reload: calls[reload], close: calls[close] };
        requireProof(pages(url('a')).length === 0 && pages(`${url('a')}?document=next`).length === 0, 'Navigation A did not close its exact own page');
        await compareWaiting(b, 'b', readyB);
        release('b');
        await waitCompleted(b);
        await verifyWorker(b, 'b');
      }
      await refresh();
      requireProof([...owned.values()].every(isTerminal) && !unknownSpawn && !unknownSubmission, 'Matrix case still has unsettled or unknown owned native work');
      for (const entry of owned.values()) {
        verifyCalls(entry);
        if (!tools(entry).some(isCancelledWait)) requireProof(runtime(entry).phase === 'completed', 'Non-cancelled stress run did not complete');
        for (const shot of tools(entry).filter(tool => action(tool) === 'screenshot')) requireProof(verifiedShots.has(String(shot.toolCallId)), 'A native PNG receipt was never independently read back');
      }
      await observeUntil(async () => (await snapshot()).filter(tab => typeof tab.url === 'string' && tab.url.startsWith(`${baseUrl}/agent-stress/${testCase}/`)
        && tab.createdBy !== null && tab.retained !== true).length === 0, 'Root terminal did not remove all non-retained group pages');
      result.verifiedAt = Date.now();
      result.outcome = 'passed';
    } catch (error) { caseFailures.push(error); result.outcome = 'failed'; }
    finally {
      // Only accepted native identities may be aborted; never infer a missing send/spawn identity.
      try {
        if (roots.length) unknownSpawn = true;
        for (const root of roots) root.view = await input.load(root.identity);
        discover();
      } catch (error) { caseFailures.push(error); }
      for (const entry of [...owned.values()].reverse()) {
        try {
          entry.view = await input.load(entry.identity);
          if (!isTerminal(entry)) {
            const runId = runtime(entry).activeRunId;
            requireProof(typeof runId === 'string', 'Owned nonterminal run has no exact public abort identity');
            requireProof(Date.now() < deadline, 'Case cleanup budget exhausted before exact owned-run cancellation');
            const receipt = await input.read('/api/capabilities/execute', { id: 'session.abort', operationId: 'sessions.abort',
              scope: { kind: 'session', identity: entry.identity }, target: { kind: 'session', identity: entry.identity },
              input: { sessionIdentity: entry.identity, sessionKey: entry.identity.sessionKey, runId } });
            (result.cleanup as unknown[]).push({ identity: entry.identity, runId, receipt });
            const end = Math.min(deadline, Date.now() + 12_000);
            while (Date.now() < end) {
              entry.view = await input.load(entry.identity);
              if (isTerminal(entry)) break;
              await delay(250);
            }
            requireProof(isTerminal(entry), 'Exact owned run did not settle after its one cleanup abort');
          }
        } catch (error) { caseFailures.push(error); }
      }
      try {
        for (const root of roots) root.view = await input.load(root.identity);
        discover();
      } catch (error) { unknownSpawn = true; caseFailures.push(error); }
      settled = !unknownSubmission && !unknownSpawn && [...owned.values()].every(entry => entry.view && isTerminal(entry));
      result.settled = settled;
      if (!settled) caseFailures.push(new Error('Owned send/spawn/run remains unknown or nonterminal; stop remaining matrix cases and preserve browser mode'));
      if (settled && baselineKnown) {
        try {
          const candidates = (await snapshot()).filter(tab => typeof tab.id === 'string' && !baselineIds.has(tab.id)
            && typeof tab.url === 'string' && tab.url.startsWith(`${baseUrl}/agent-stress/${testCase}/`));
          for (const tab of candidates) {
            try {
              requireProof(uiPageIds.has(String(tab.id)) || [...owned.values()].some(entry => matchesIdentity(tab.createdBy, entry.identity)), 'Remaining stress tab does not have a confirmed exact matrix creator');
              requireProof(typeof tab.ownerId === 'string', 'Remaining stress tab has no public native ownerId');
              const tabs = workspace.locator(`[role="tab"][data-page-id=${JSON.stringify(`iab:${tab.ownerId}:${String(tab.id)}`)}]`);
              if (await tabs.count() !== 1) {
                const root = roots.find(entry => matchesIdentity(tab.sessionGroupId, entry.identity));
                requireProof(root?.row, 'Hidden owned tab has no exact root row; do not guess another session');
                await selectRoot(root);
              }
              requireProof(await tabs.count() === 1 && Date.now() < deadline, 'Exact owned stress tab is hidden or cleanup budget expired; do not close another tab');
              await tabs.getByRole('button').click({ timeout: Math.max(1, Math.min(3_000, deadline - Date.now())) });
              requireProof(!(await snapshot()).some(current => current.id === tab.id), 'Exact matrix UI tab close was not confirmed');
              (result.cleanup as unknown[]).push({ closedTabId: tab.id, url: tab.url, via: 'UI' });
            } catch (error) { caseFailures.push(error); }
          }
          const remaining = (await snapshot()).filter(tab => typeof tab.url === 'string' && tab.url.startsWith(`${baseUrl}/agent-stress/${testCase}/`));
          result.remainingTabs = remaining;
          requireProof(remaining.length === 0, 'Confirmed matrix tabs remain after bounded UI cleanup');
        } catch (error) { caseFailures.push(error); }
      }
      result.owned = [...owned.values()];
      result.site = state();
      result.finishedAt = Date.now();
      result.errors = caseFailures.map(errorEvidence);
      if (caseFailures.length) result.outcome = 'failed';
      result.status = result.outcome;
      failures.push(...caseFailures);
      try { await persist(); } catch (error) { failures.push(error); caseFailures.push(error); result.errors = caseFailures.map(errorEvidence); result.status = result.outcome = 'failed'; }
    }
  }
  evidence.settled = settled;
  evidence.finishedAt = Date.now();
  evidence.outcome = failures.length ? 'failed' : 'passed';
  evidence.errors = failures.map(errorEvidence);
  try { await persist(); } catch (error) { failures.push(error); }
  return { identity: firstIdentity, settled, failures };
}
