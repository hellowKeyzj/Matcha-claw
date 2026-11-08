import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { UseElectron } from './use-electron.ability.js';
import type { IabTestSite } from './iab-test-site.ability.js';
import { verifyIabStress } from './iab-agent-stress.ability.js';

type Identity = { endpoint: { kind: string; runtimeAdapterId: string; runtimeInstanceId: string }; agentId: string; sessionKey: string };
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function facts(value: unknown): unknown {
  const projection = record(value);
  return projection.complete ?? record(projection.incomplete).facts;
}
function toolContent(tool: Record<string, unknown>): Record<string, unknown>[] {
  const output = tool.output;
  const content = Array.isArray(output) ? output : record(output).content;
  return Array.isArray(content) ? content.map(record) : [];
}
function screenshotImage(tool: Record<string, unknown>): Record<string, unknown> | undefined {
  return toolContent(tool).find(content => content.type === 'image' && content.mimeType === 'image/png');
}

export class IabAgent extends Ability {
  constructor(private readonly electron: UseElectron, private readonly site: IabTestSite) { super(); }

  private get main() { return this.electron.page; }
  private readonly evidence: Record<string, unknown> = { modelMessagesSubmitted: 0 };
  private readonly agentNames = new Map<string, string>([['main', 'main']]);

  async verify(scenario: 'multi-step' | 'simple' | 'complex' | 'parallel' | 'subagents' | 'stress' = 'multi-step'): Promise<boolean> {
    const failures: unknown[] = [];
    const settings = await this.read('/api/settings');
    const initialMode = String(settings.browserMode);
    if (!['iab', 'relay', 'native', 'off'].includes(initialMode)) throw new Error('Browser mode baseline is invalid');
    const pane = this.main.getByTestId('agent-sessions-pane');
    const input = this.main.getByTestId('chat-composer-input');
    const send = this.main.locator('[data-chat-control="send"]');
    const workspace = this.main.locator('[data-workspace-pane="side"]');
    const tabs = workspace.locator('[role="tab"][data-page-id^="iab:"]');
    const initialTabs = await tabs.evaluateAll(elements => elements.map(element => element.getAttribute('data-page-id')));
    const initialSelection = await pane.locator('button[aria-current="true"]').evaluateAll(elements => elements.map(element => ({
      title: element.getAttribute('title'), listId: element.parentElement?.parentElement?.id,
    })));
    if (await input.inputValue() !== '' || initialSelection.length > 1) throw new Error('Initial chat selection cannot be safely restored');
    const activeHeaders = await pane.locator('section').evaluateAll(sections => sections.filter(section => section.firstElementChild?.classList.contains('bg-secondary/70'))
      .map(section => section.querySelector('button[aria-controls]')?.getAttribute('title')));
    if (!initialSelection.length && (activeHeaders.length !== 1 || !activeHeaders[0])) throw new Error('Initial empty draft has no unique active Agent');
    const mainHeader = pane.locator('button[aria-controls][title="OpenClaw / main"]');
    await mainHeader.waitFor();
    const mainSection = mainHeader.locator('xpath=ancestor::section[1]');
    const initiallyExpanded = await mainHeader.getAttribute('aria-expanded');
    const openedPanel = await this.main.getByRole('button', { name: /^(打开右侧栏|Open side panel)$/ }).isVisible();
    let modeChanged = false;
    let identity: Identity | undefined;
    let runSettled = true;
    try {
      if (initialMode !== 'iab') {
        await this.chooseMode('iab');
        modeChanged = true;
        await this.returnToChat();
      }
      await this.waitGateway();
      await mainHeader.hover();
      await mainSection.getByRole('button', { name: /^(与 main 新建会话|New session with main)$/ }).click();
      await this.until(async () => await pane.locator('button[aria-current="true"]').count() === 0 && await input.inputValue() === '', 5_000, 'New empty main draft did not become current');
      const modelPicker = this.main.getByTestId('chat-model-picker');
      await this.until(async () => {
        const label = await modelPicker.getAttribute('title');
        return await modelPicker.getAttribute('aria-busy') !== 'true' && Boolean(label) && !/^(选择模型|Choose model|モデルを選択|Выбрать модель)$/.test(label!);
      }, 15_000, 'Default draft model did not finish loading');
      const modelLabel = await modelPicker.getAttribute('title');
      this.evidence.modelLabel = modelLabel;
      this.evidence.originalBrowserMode = initialMode;
      if (!modelLabel) throw new Error('Current default model is not visible');
      const baseline = await this.catalog();
      const { baseUrl } = await this.site.prepare();
      this.evidence.scenario = scenario;
      if (openedPanel) await this.main.getByRole('button', { name: /^(打开右侧栏|Open side panel)$/ }).click();
      await workspace.waitFor();
      if (scenario === 'stress') {
        const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' };
        const directory = await this.read('/api/runtime-endpoints/list');
        if (!Array.isArray(directory.endpoints)) throw new Error('Runtime endpoint directory is unavailable');
        const managementAgentId = record(directory.endpoints.map(record).find(entry => isDeepStrictEqual(entry.endpointRef, endpoint))).defaultAgentId;
        if (typeof managementAgentId !== 'string') throw new Error('Stress matrix requires the real OpenClaw management Agent');
        const roster = await this.read('/api/subagents/agents', { id: 'subagent.management', operationId: 'subagents.list',
          scope: { kind: 'agent', endpoint, agentId: managementAgentId }, target: { kind: 'agent', agentId: managementAgentId }, input: { kind: 'list', endpoint } });
        if (roster.success !== true || !Array.isArray(roster.agents)) throw new Error('Independent Agent roster is unavailable');
        const agents = roster.agents.map(record);
        const independent = agents.find(agent => typeof agent.id === 'string' && agent.id !== 'main' && agent.kind === 'agent' && agent.sealed === false);
        if (!independent) throw new Error('Stress matrix requires a configured independent OpenClaw Agent besides main; no Agent was created or reconfigured');
        for (const agent of agents) this.agentNames.set(String(agent.id), typeof agent.name === 'string' && agent.name.trim() ? agent.name.trim() : String(agent.id));
        this.evidence.independentAgentIds = ['main', independent.id];
        runSettled = false;
        const outcome = await verifyIabStress({
          electron: this.electron, site: this.site, independentAgentId: String(independent.id),
          sendOnce: (prompt, agentId, onSubmit) => this.sendOnce(prompt, agentId, onSubmit), load: current => this.load(current),
          read: (path, body) => this.read(path, body),
          verifyScreenshot: (tool, current, path) => this.verifyScreenshot(tool, current, path),
          save: async evidence => { this.evidence.stress = evidence; await this.save(); },
        }, baseUrl);
        identity = outcome.identity;
        runSettled = outcome.settled;
        failures.push(...outcome.failures);
      } else if (scenario === 'parallel' || scenario === 'subagents') {
        const outcome = await this.verifyConcurrent(scenario, baseUrl);
        identity = outcome.identity;
        runSettled = outcome.settled;
        if (outcome.failures.length) throw new AggregateError(outcome.failures, `${scenario} browser verification failed`);
      } else {
      await workspace.getByRole('button', { name: /^(打开页面|Open a page)$/ }).click();
      const browser = await this.electron.connectBrowser();
      await this.until(async () => browser.contexts().flatMap(context => context.pages()).some(page => page.url().endsWith('/iab/overlay/index.html')), 8_000, 'Workspace menu overlay did not appear');
      const overlays = browser.contexts().flatMap(context => context.pages()).filter(page => page.url().endsWith('/iab/overlay/index.html'));
      if (overlays.length !== 1) throw new Error(`Workspace menu expected one overlay, found ${overlays.length}`);
      await overlays[0].getByRole('menuitem', { name: /^(浏览器|Browser)$/ }).click();
      const address = this.main.locator('[data-browser-surface]:visible').getByLabel(/^(搜索或输入网址|Search or enter a URL)$/);
      const pageUrl = baseUrl + (scenario === 'complex' ? '/agent-complex' : '/agent');
      await address.fill(pageUrl);
      await address.press('Enter');
      await this.until(async () => browser.contexts().flatMap(context => context.pages()).some(page => page.url() === pageUrl), 8_000, 'Challenge page did not open');
      const challengePage = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === pageUrl)!;
      await challengePage.locator(scenario === 'complex' ? '#text' : '#challenge').waitFor();
      const savePath = `iab-agent-${randomUUID()}.png`;
      this.evidence.savePath = savePath;
      const prompt = scenario === 'simple'
        ? `仅执行一次简单浏览器任务，只用browser工具；先status确认profile=iab、driver=electron，否则停止。tabs找到${pageUrl}，snapshot读页面验证码，逐字输入“输入页面验证码”，点击“验证输入”，snapshot确认“验证通过”，最后简短报告验证码。不要新建/关闭页面、不改配置、不调用其他工具。失败即停止，不重试。`
        : scenario === 'complex'
          ? `只用browser工具执行一轮复杂浏览器任务，失败即停不重试，不用exec/HTTP/其他工具。先status确认profile=iab、driver=electron，然后tabs找到${pageUrl}。依序：snapshot；用storage local set写入唯一键iab_complex值${this.site.agentChallenge}；utility reload后用storage get读回同值；snapshot重新取得refs；用act fill一次填“中文输入”为${this.site.agentChallenge}、“粘贴输入”为复杂中文已填写；点击“应用”；勾选“复选框”；act select把“选择”改two；scroll到底部，点击“底部按钮”；snapshot确认clicked；回顶部；点击“普通”跳到${baseUrl}/agent，snapshot确认页面验证码，再utility goBack返回复杂页；返回后snapshot，重新完成上述两输入、应用、下拉和底部按钮；根据snapshot当前状态确保“复选框”勾选，未勾选才点击，已勾选则保持，保证最终值准确；screenshot type=png savePath=${JSON.stringify(savePath)}；focus回本页、snapshot确认。不要关闭标签或改设置。最终报告实际读回的存储值与结果。`
          : `只做一轮内置浏览器验收，只用 browser 工具，不得使用 exec、脚本、HTTP 或其他工具。需要在操作过程中给我可见的进度正文，不要只写在思考里，也不要等最后才统一回复。第一次调用工具之前，先向我发送“开始验收，我先确认浏览器环境”，然后立即继续调用工具，不要结束任务或等待我回复。先 status 确认 profile=iab、driver=electron；不符合就停止并报告。用 tabs 找到 ${baseUrl}/agent，不要新建副本。snapshot 读取页面验证码。读到验证码后、填写之前，向我发送“验证码已读到，我继续填写并验证”，随后继续调用工具，将验证码逐字输入“输入页面验证码”，点击“验证输入”，再次 snapshot 确认“验证通过”。确认通过后，向我发送“输入已验证，我继续检查子页和截图”，随后继续调用工具：点击“打开验收子页”，用 tabs 找到 ${baseUrl}/agent-child，focus 子页、snapshot 确认“子页已打开”，对子页 screenshot，type="png"，savePath 必须且只能使用本轮唯一的工作区相对路径 ${JSON.stringify(savePath)}，不得省略保存路径或另选路径，保存失败立即停止，不重试截图。最后 focus 回原页，snapshot 确认输入结果仍为“验证通过”。不要关闭标签，不要改配置。最后只简短报告读到的验证码与各动作结果，不重复前面的进度句；某步失败立即停止，不重复发送任务。`;
      this.evidence.prompt = prompt;
      this.evidence.challenge = this.site.agentChallenge;
      await input.fill(prompt);
      await this.until(async () => await send.isEnabled(), 8_000, 'Chat send button is not enabled');
      runSettled = false;
      this.evidence.modelMessagesSubmitted = 1;
      await this.save();
      await send.click();
      const deadline = Date.now() + (scenario === 'complex' ? 600_000 : 300_000);
      let finalView: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        if (!identity) {
          const added = (await this.catalog()).filter(candidate => !baseline.some(previous => isDeepStrictEqual(previous, candidate)));
          if (added.length > 1) throw new Error('The only send created multiple session identities; never resend');
          identity = added[0];
        }
        if (identity) {
          const view = await this.load(identity);
          const items = facts(view.items);
          const tools = facts(view.tools);
          const runtime = record(facts(view.runtime));
          this.evidence.identity = identity;
          this.evidence.runtime = runtime;
          this.evidence.modelState = view.modelState;
          if (Array.isArray(items)) this.evidence.items = items;
          if (Array.isArray(tools)) this.observeTools(tools);
          await this.save();
          if (Array.isArray(items) && items.filter(item => record(item).kind === 'userMessage' && record(item).text === prompt).length > 1) throw new Error('Duplicate user sends detected');
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(String(runtime.phase)) && runtime.activeRunId === null) {
            runSettled = true;
            finalView = view;
            break;
          }
          if (runtime.phase === 'waiting_for_approval') throw new Error('Agent is waiting for approval; no blanket authorization was injected');
        }
        await delay(600);
      }
      const result = await challengePage.locator(scenario === 'complex' ? '#applied' : '#result').textContent();
      const answer = await challengePage.locator(scenario === 'complex' ? '#text' : '#answer').inputValue();
      const childPages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === baseUrl + '/agent-child');
      const childText = childPages.length === 1 ? await childPages[0].locator('#child-proof').textContent() : null;
      const pageVisible = await challengePage.evaluate(() => document.visibilityState === 'visible');
      this.evidence.independentDom = { result, answer, childCount: childPages.length, childText, originalPageVisible: pageVisible };
      await challengePage.screenshot({ path: join(this.electron.outputDirectory, 'iab-agent-page.png') });
      if (childPages.length === 1) await childPages[0].screenshot({ path: join(this.electron.outputDirectory, 'iab-agent-child.png') });
      const tools = facts(finalView?.tools);
      const calls = Array.isArray(tools) ? tools.map(record).filter(tool => tool.name === 'browser') : [];
      const actions = calls.map(tool => String(record(tool.input).action));
      const status = calls.find(tool => record(tool.input).action === 'status');
      const statusText = status ? toolContent(status).map(content => content.text ?? '').join('\n') : '';
      const items = facts(finalView?.items);
      const turns = Array.isArray(items) ? items.map(record).filter(item => item.kind === 'assistantTurn') : [];
      const runIds = new Set(turns.map(turn => turn.runId));
      const statusIsIab = /"profile"\s*:\s*"iab"/.test(statusText) && /"driver"\s*:\s*"electron"/.test(statusText);
      const screenshot = calls.find(tool => record(tool.input).action === 'screenshot' && record(tool.input).savePath === savePath && screenshotImage(tool));
      this.evidence.verification = { actions, statusIsIab, screenshotObserved: Boolean(screenshot), screenshotFileVerified: false, callsHaveNativeIdentity: calls.length > 0 && calls.every(tool => typeof tool.toolCallId === 'string' && typeof tool.runId === 'string' && runIds.has(tool.runId)) };
      await this.save();
      if (!finalView || record(facts(finalView.runtime)).phase !== 'completed') throw new Error('Agent did not complete the only run within the bounded observation; never resend');
      const failedTool = calls.find(tool => tool.isError === true || tool.phase === 'failed');
      if (failedTool) throw new Error(`Native browser ${record(failedTool.input).action} failed: ${toolContent(failedTool).map(content => content.text ?? '').join('\n')}`);
      if (answer !== this.site.agentChallenge || !pageVisible || result !== (scenario === 'complex' ? this.site.agentChallenge : '验证通过')
        || scenario === 'multi-step' && childText !== '子页已打开') throw new Error('Independent browser DOM did not confirm all requested actions');
      const required = scenario === 'simple' ? ['status', 'tabs', 'snapshot', 'act']
        : scenario === 'complex' ? ['status', 'tabs', 'snapshot', 'act', 'storage', 'utility', 'scroll', 'screenshot']
          : ['status', 'tabs', 'snapshot', 'act', 'focus', 'screenshot'];
      if (!statusIsIab || !Array.isArray(tools) || tools.length !== calls.length || !calls.every(tool => tool.isError !== true && typeof tool.toolCallId === 'string' && typeof tool.runId === 'string' && runIds.has(tool.runId))
        || !required.every(action => actions.includes(action))) throw new Error('Native browser tool records did not prove the requested IAB chain');
      if (scenario === 'complex') {
        const state = await challengePage.evaluate(() => ({ paste: (document.querySelector('#paste') as HTMLInputElement).value,
          checked: (document.querySelector('#check') as HTMLInputElement).checked, choice: (document.querySelector('#choice') as HTMLSelectElement).value,
          bottom: document.querySelector('#bottom-result')?.textContent, storage: localStorage.getItem('iab_complex') }));
        this.evidence.complexDom = state;
        if (state.paste !== '复杂中文已填写' || !state.checked || state.choice !== 'two' || state.bottom !== 'clicked' || state.storage !== this.site.agentChallenge
          || !['fill', 'select'].every(kind => calls.some(tool => record(record(tool.input).request).kind === kind))
          || !['reload', 'goBack'].every(kind => calls.some(tool => record(record(tool.input).request).kind === kind))) throw new Error('Complex form, navigation or storage verification failed');
      }
      if (scenario !== 'simple') {
        if (!identity || !screenshot) throw new Error('Screenshot lacks the exact native identity or successful tool receipt');
        await this.verifyScreenshot(screenshot, identity, savePath);
        record(this.evidence.verification).screenshotFileVerified = true;
      }
      if (!turns.some(turn => turn.status === 'final' && String(turn.text).includes(this.site.agentChallenge))) throw new Error('Final Agent response did not report the value read from the page');
      }
    } catch (error) { failures.push(error); }
    finally {
      if (!runSettled && identity && scenario !== 'parallel' && scenario !== 'subagents' && scenario !== 'stress') {
        try {
          if (await send.getAttribute('aria-label') === '停止' || await send.getAttribute('aria-label') === 'Stop') await send.click();
        } catch (error) { failures.push(error); }
        try {
          await this.until(async () => {
            const runtime = record(facts((await this.load(identity!)).runtime));
            return ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(runtime.phase)) && runtime.activeRunId === null;
          }, 12_000, 'Only-run cancellation/terminal outcome remains unknown');
          runSettled = true;
        } catch (error) { failures.push(error); }
      }
      if (!runSettled) failures.push(new Error('Only-run identity or terminal outcome is unknown; do not restore browser mode while it may be active'));
      if (runSettled) {
        try {
          const current = await tabs.evaluateAll(elements => elements.map(element => ({
            id: element.getAttribute('data-page-id'), title: element.textContent?.trim(),
          })));
          const closedPageIds: string[] = [];
          this.evidence.closedPageIds = closedPageIds;
          for (const { id, title } of current) {
            if (!id || initialTabs.includes(id) || !/^IAB Agent (Challenge|Child|Complex|Worker [AB]|Coordinator)$/.test(title ?? '')) continue;
            try {
              const tab = workspace.locator(`[role="tab"][data-page-id=${JSON.stringify(id)}]`);
              await tab.getByRole('button').click();
              await this.until(async () => await tab.count() === 0, 5_000, `Owned browser tab did not close: ${id}`);
              closedPageIds.push(id);
            } catch (error) { failures.push(error); }
          }
        } catch (error) { failures.push(error); }
        try { if (modeChanged) await this.chooseMode(initialMode); } catch (error) { failures.push(error); }
        try {
          await this.returnToChat();
          try {
            if (initialSelection.length) {
              const original = initialSelection[0];
              const row = pane.locator(`[id=${JSON.stringify(original.listId)}] button[title=${JSON.stringify(original.title)}]`);
              if (await row.count() !== 1) throw new Error('Original session is not uniquely identifiable');
              await row.click();
              await this.until(async () => await row.getAttribute('aria-current') === 'true', 5_000, 'Original session was not restored');
            } else {
              const header = pane.locator(`button[aria-controls][title=${JSON.stringify(activeHeaders[0])}]`);
              await header.hover();
              await header.locator('xpath=ancestor::section[1]').getByRole('button', { name: /^(与 .+ 新建会话|New session with .+)$/ }).click();
              await this.until(async () => await pane.locator('button[aria-current="true"]').count() === 0 && await input.inputValue() === ''
                && await header.locator('xpath=ancestor::section[1]').locator(':scope > div').first().evaluate(element => element.classList.contains('bg-secondary/70')), 5_000, 'Original empty draft was not restored');
            }
          } catch (error) { failures.push(error); }
          try {
            if (await mainHeader.getAttribute('aria-expanded') !== initiallyExpanded) await mainHeader.click();
            await this.until(async () => await mainHeader.getAttribute('aria-expanded') === initiallyExpanded, 5_000, 'Original Agent expansion was not restored');
          } catch (error) { failures.push(error); }
          try {
            if (openedPanel && await workspace.isVisible()) await workspace.getByRole('button', { name: /^(收起工作区|Collapse workspace)$/ }).click();
            if (!openedPanel && !await workspace.isVisible()) await this.main.getByRole('button', { name: /^(打开右侧栏|Open side panel)$/ }).click();
            await this.until(async () => await workspace.isVisible() === !openedPanel, 5_000, 'Original workspace visibility was not restored');
          } catch (error) { failures.push(error); }
        } catch (error) { failures.push(error); }
      }
      try {
        const restored = await this.read('/api/settings');
        if (!isDeepStrictEqual(restored, settings)) throw new Error('Original settings were not restored exactly');
        this.evidence.settingsRestored = true;
      } catch (error) { failures.push(error); }
      this.evidence.outcome = failures.length ? 'failed' : 'passed';
      this.evidence.errors = failures.map(error => error instanceof Error ? error.message : String(error));
      try { await this.save(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, `Agent browser verification failed: ${this.evidence.errors}`);
    return true;
  }

  private async verifyConcurrent(scenario: 'parallel' | 'subagents', baseUrl: string): Promise<{ identity?: Identity; settled: boolean; failures: unknown[] }> {
    const failures: unknown[] = [];
    const roots: Identity[] = [];
    const workers = new Map<string, Identity>();
    const views = new Map<string, Record<string, unknown>>();
    const savePaths = { a: `iab-worker-a-${randomUUID()}.png`, b: `iab-worker-b-${randomUUID()}.png` };
    const browser = await this.electron.connectBrowser();
    const page = (worker: string) => browser.contexts().flatMap(context => context.pages()).filter(candidate => !candidate.isClosed() && candidate.url() === `${baseUrl}/agent-worker/${worker}`);
    const workerPrompt = (worker: 'a' | 'b') => `仅用browser工具操作自己的网页，失败即停不重试。先status确认profile=iab、driver=electron。open ${baseUrl}/agent-worker/${worker}，retain=false。snapshot读取页面验证码，type输入“输入页面验证码”，点击“登记就绪”。必须等#gate可见文本“可以提交”：act request={kind:"wait",text:"可以提交",timeoutMs:240000}，不可提前结束、不可改网页脚本。等待成功后tabs检查自己的页仍在，snapshot取最新refs；screenshot type=png savePath=${JSON.stringify(savePaths[worker])}；点击“提交结果”，snapshot确认“验证通过”，最后报告验证码。只操作open返回的本页targetId，不关闭任何页面、不改设置、不使用其他工具。`;
    const terminal = (view: Record<string, unknown>) => {
      const runtime = record(facts(view.runtime));
      return runtime.activeRunId === null && ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(runtime.phase));
    };
    try {
      if (scenario === 'parallel') {
        roots.push(await this.sendOnce(workerPrompt('a')));
        workers.set('a', roots[0]);
        await this.until(async () => this.site.workerResults().a.readyAt !== null, 180_000, 'First real Agent did not register its own page');
        roots.push(await this.sendOnce(workerPrompt('b')));
        workers.set('b', roots[1]);
      } else {
        roots.push(await this.sendOnce(`仅做一次真实子Agent浏览器分工验收。只允许browser和sessions_spawn，禁止exec/HTTP/脚本/其他工具，失败即停止、不重派。先browser status确认profile=iab、driver=electron；browser open ${baseUrl}/agent-coordinator retain=false。然后必须不等待A完成就连续sessions_spawn两个独立native子Agent，agentId=main、runtime=subagent、mode=run、cleanup=keep、runTimeoutSeconds=360，不改模型，task分别逐字使用以下任务：A=${JSON.stringify(workerPrompt('a'))}；B=${JSON.stringify(workerPrompt('b'))}。保留两个childSessionKey/runId回执。你自己不操作worker页。两次spawn接受后，在协调页browser act request={kind:"wait",text:"全部完成",timeoutMs:300000}，必须等网站确认全部完成，不要提前final、不忙轮询。再snapshot确认协调页“全部完成”，按原生spawn完成通知汇总两个子Agent结果，不再派新任务。`));
      }
      const deadline = Date.now() + 480_000;
      let released = false;
      let finished = false;
      while (Date.now() < deadline) {
        for (const identity of [...roots, ...workers.values()]) {
          const view = await this.load(identity);
          views.set(identity.sessionKey, view);
          const tools = facts(view.tools);
          if (Array.isArray(tools) && tools.map(record).some(tool => tool.phase === 'failed' || tool.isError === true)) throw new Error(`Native tool failed in ${identity.sessionKey}`);
          const runtime = record(facts(view.runtime));
          if (runtime.phase === 'waiting_for_approval') throw new Error('Concurrent Agent requires approval; no blanket authorization injected');
          if (terminal(view) && runtime.phase !== 'completed') throw new Error(`Concurrent Agent terminated with ${runtime.phase}`);
        }
        if (scenario === 'subagents') {
          const root = views.get(roots[0].sessionKey)!;
          const tools = facts(root.tools);
          const spawns = Array.isArray(tools) ? tools.map(record).filter(tool => tool.name === 'sessions_spawn' && tool.phase === 'completed') : [];
          if (spawns.length > 2) throw new Error('Root spawned more than the two authorized workers');
          for (const spawn of spawns) {
            const task = String(record(spawn.input).task);
            const worker = task === workerPrompt('a') ? 'a' : task === workerPrompt('b') ? 'b' : undefined;
            if (!worker) throw new Error('Spawn task was not the exact worker contract');
            const text = toolContent(spawn).map(content => String(content.text ?? '')).join('\n');
            const receipt = record(JSON.parse(text));
            if (receipt.status !== 'accepted' || typeof receipt.childSessionKey !== 'string' || typeof receipt.runId !== 'string') throw new Error('Native spawn did not provide an accepted child identity and run');
            const existing = workers.get(worker);
            if (existing && existing.sessionKey !== receipt.childSessionKey) throw new Error('Worker native identity changed');
            workers.set(worker, { ...roots[0], sessionKey: receipt.childSessionKey });
          }
          if (terminal(root) && (!finished && this.site.workerResults().b.completedAt === null)) throw new Error('Root ended before its children completed');
        }
        const a = workers.get('a'), b = workers.get('b');
        const state = this.site.workerResults();
        if (!released && a && b && views.has(a.sessionKey) && views.has(b.sessionKey) && terminal(views.get(a.sessionKey)!)) {
          if (a.sessionKey === b.sessionKey || state.a.readyAt === null || state.b.readyAt === null || state.a.completedAt === null || state.b.completedAt !== null
            || terminal(views.get(b.sessionKey)!) || page('b').length !== 1) throw new Error('A completion did not leave the distinct B Agent and page active');
          if (await page('b')[0].locator('#answer').inputValue() !== this.site.workerChallenge('b') || await page('b')[0].locator('#gate').textContent() !== '等待A完成') throw new Error('B page was changed or lost when A finished');
          await this.until(async () => page('a').length === (scenario === 'parallel' ? 0 : 1), 8_000, 'A page lifecycle did not match independent-root versus child ownership');
          this.evidence.afterWorkerA = { observedAt: Date.now(), aPageCount: page('a').length, bPageCount: page('b').length, aRuntime: facts(views.get(a.sessionKey)!.runtime), bRuntime: facts(views.get(b.sessionKey)!.runtime) };
          this.site.releaseWorkerB();
          released = true;
        }
        this.evidence.concurrent = { identities: Object.fromEntries(workers), roots, state: this.site.workerResults(), views: Object.fromEntries(views) };
        await this.save();
        finished = released && workers.size === 2 && [...workers.values(), ...roots].every(identity => views.has(identity.sessionKey) && terminal(views.get(identity.sessionKey)!));
        if (finished) break;
        await delay(600);
      }
      if (!finished) throw new Error('Concurrent native runs did not complete within the bounded observation; no resend');
      const state = this.site.workerResults();
      if (state.a.readyAt === null || state.b.readyAt === null || state.a.completedAt === null || state.b.completedAt === null || state.releaseBAt === null
        || Math.max(state.a.readyAt, state.b.readyAt) >= state.a.completedAt || state.a.completedAt > state.releaseBAt || state.releaseBAt >= state.b.completedAt
        || state.a.answer !== this.site.workerChallenge('a') || state.b.answer !== this.site.workerChallenge('b')) throw new Error('Website did not independently prove concurrent, isolated, ordered completion');
      const targets = new Map<string, string>();
      for (const worker of ['a', 'b'] as const) {
        const identity = workers.get(worker)!;
        const view = views.get(identity.sessionKey)!;
        const tools = facts(view.tools);
        const items = facts(view.items);
        if (!Array.isArray(tools) || !Array.isArray(items)) throw new Error('Concurrent view omitted native facts');
        const turns = items.map(record).filter(item => item.kind === 'assistantTurn');
        const calls = tools.map(record);
        if (!calls.length || calls.some(tool => tool.name !== 'browser' || tool.phase !== 'completed' || tool.isError === true || typeof tool.toolCallId !== 'string' || typeof tool.runId !== 'string' || !turns.some(turn => turn.runId === tool.runId))) throw new Error('Worker calls did not retain exact native run identities');
        const open = calls.find(tool => record(tool.input).action === 'open' && record(tool.input).url === `${baseUrl}/agent-worker/${worker}`);
        const target = open && /"targetId"\s*:\s*"([^"]+)"/.exec(toolContent(open).map(content => String(content.text ?? '')).join('\n'))?.[1];
        if (!target) throw new Error('Worker did not open its own identifiable page');
        targets.set(worker, target);
        if (!['status', 'open', 'snapshot', 'act', 'tabs', 'screenshot'].every(action => calls.some(tool => record(tool.input).action === action))
          || calls.some(tool => typeof record(tool.input).targetId === 'string' && record(tool.input).targetId !== target)) throw new Error('Worker did not remain on its own page');
        const shot = calls.find(tool => record(tool.input).action === 'screenshot' && record(tool.input).savePath === savePaths[worker] && screenshotImage(tool));
        if (!shot) throw new Error('Worker screenshot was not successfully saved');
        await this.verifyScreenshot(shot, identity, savePaths[worker]);
      }
      if (targets.get('a') === targets.get('b')) throw new Error('Distinct Agents shared the same target');
      for (const worker of ['a', 'b'] as const) {
        const calls = facts(views.get(workers.get(worker)!.sessionKey)!.tools) as unknown[];
        const other = targets.get(worker === 'a' ? 'b' : 'a')!;
        if (scenario === 'parallel' && calls.map(record).filter(tool => record(tool.input).action === 'tabs').some(tool => toolContent(tool).some(content => String(content.text ?? '').includes(`"targetId": "${other}"`)))) throw new Error('An independent-root page leaked into the other worker tab listing');
      }
      await this.until(async () => !page('a').length && !page('b').length && !browser.contexts().flatMap(context => context.pages()).some(candidate => candidate.url() === baseUrl + '/agent-coordinator'), 10_000, 'Root terminal did not clean its temporary pages');
      this.evidence.concurrentVerified = true;
    } catch (error) { failures.push(error); }
    finally {
      for (const identity of new Map([...workers.values(), ...roots].map(identity => [identity.sessionKey, identity])).values()) {
        try {
          let view = await this.load(identity);
          if (!terminal(view)) {
            const runId = record(facts(view.runtime)).activeRunId;
            if (typeof runId !== 'string') throw new Error('Owned pending run lacks a confirmed abort identity');
            const reply = await this.read('/api/capabilities/execute', { id: 'session.abort', operationId: 'sessions.abort', scope: { kind: 'session', identity }, target: { kind: 'session', identity }, input: { sessionIdentity: identity, sessionKey: identity.sessionKey, runId } });
            this.evidence.cleanupAbort = { identity, runId, receipt: reply };
            await this.until(async () => { view = await this.load(identity); return terminal(view); }, 15_000, 'Owned concurrent run did not settle after cleanup abort');
          }
          views.set(identity.sessionKey, view);
        } catch (error) { failures.push(error); }
      }
    }
    return { identity: roots[0], settled: roots.length > 0 && [...workers.values(), ...roots].every(identity => views.has(identity.sessionKey) && terminal(views.get(identity.sessionKey)!)), failures };
  }

  private async sendOnce(prompt: string, agentId = 'main', onSubmit?: () => void): Promise<Identity> {
    const baseline = await this.catalog(agentId);
    const pane = this.main.getByTestId('agent-sessions-pane');
    const name = this.agentNames.get(agentId);
    if (!name) throw new Error('Only a publicly confirmed Agent may receive a browser task');
    const header = pane.locator(`button[aria-controls][title=${JSON.stringify(`OpenClaw / ${name}`)}]`);
    if (await header.count() === 0) {
      await pane.getByRole('button', { name: /^(选择 Agent|Select agent)$/ }).click();
      await this.main.getByRole('menuitem', { name: /^(全部 Agent|All agents)$/ }).click();
    }
    await header.hover();
    await header.locator('xpath=ancestor::section[1]').getByRole('button', { name: /^(与 .+ 新建会话|New session with .+)$/ }).click();
    const input = this.main.getByTestId('chat-composer-input');
    await this.until(async () => await pane.locator('button[aria-current="true"]').count() === 0 && await input.inputValue() === '', 5_000, 'Concurrent draft did not become current');
    if (this.evidence.scenario === 'stress') {
      const picker = this.main.getByTestId('chat-model-picker');
      await this.until(async () => await picker.getAttribute('aria-busy') !== 'true', 8_000, 'Selected Agent model is still loading');
      if (await picker.getAttribute('title') !== this.evidence.modelLabel) {
        await picker.click();
        const dialog = this.main.getByRole('dialog', { name: /^(切换当前 Agent 模型|Switch model for this chat)$/ });
        const option = dialog.getByRole('radio', { name: String(this.evidence.modelLabel), exact: true });
        if (await option.count() !== 1) throw new Error('The authorized default model is not uniquely available for this independent draft');
        await this.until(async () => await option.getAttribute('aria-disabled') !== 'true' && await option.isEnabled(), 8_000, 'Independent draft model selection is unavailable');
        await option.click();
        await this.until(async () => await picker.getAttribute('title') === this.evidence.modelLabel && await picker.getAttribute('aria-busy') !== 'true', 8_000, 'Independent draft did not select the authorized model');
        await this.main.keyboard.press('Escape');
        await this.until(async () => await dialog.count() === 0, 5_000, 'Draft model picker did not close');
      }
    }
    await input.fill(prompt);
    const send = this.main.locator('[data-chat-control="send"]');
    await this.until(async () => await send.isEnabled(), 8_000, 'Concurrent send unavailable');
    this.evidence.modelMessagesSubmitted = Number(this.evidence.modelMessagesSubmitted) + 1;
    await this.save();
    onSubmit?.();
    await send.click();
    let identity: Identity | undefined;
    await this.until(async () => {
      const added = (await this.catalog(agentId)).filter(candidate => !baseline.some(previous => isDeepStrictEqual(previous, candidate)));
      for (const candidate of added) {
        const items = facts((await this.load(candidate)).items);
        if (!Array.isArray(items)) continue;
        const matches = items.map(record).filter(item => item.kind === 'userMessage' && item.text === prompt);
        if (matches.length > 1 || matches.length === 1 && identity && !isDeepStrictEqual(identity, candidate)) throw new Error('The only send produced ambiguous or duplicate native user identity');
        if (matches.length === 1) identity = candidate;
      }
      return identity !== undefined;
    }, 25_000, 'Submitted concurrent task identity remains unknown; never resend');
    return identity!;
  }

  private async chooseMode(mode: string): Promise<void> {
    await this.main.locator('button[title="Settings"], button[title="设置"]').click();
    await this.main.getByRole('navigation', { name: /^(Settings|设置)$/ }).getByRole('button', { name: /^(浏览器|Browser)$/ }).click();
    const labels: Record<string, RegExp> = { iab: /^内置浏览器|^Built-in browser/, relay: /^Chrome 扩展|^Chrome extension/, native: /^独立浏览器|^Dedicated browser/, off: /^关闭|^Off/ };
    const option = this.main.getByTestId('settings-page').getByRole('button', { name: labels[mode] });
    await option.click();
    await this.until(async () => (await this.read('/api/settings')).browserMode === mode && await option.isEnabled(), 30_000, 'Browser mode save was not confirmed; never repeat the click');
  }

  private async returnToChat(): Promise<void> {
    if (!await this.main.getByTestId('chat-composer-input').isVisible()) await this.main.getByRole('button', { name: /^(New Chat|新对话)$/i }).click();
    await this.main.getByTestId('chat-composer-input').waitFor();
  }

  private async waitGateway(): Promise<void> {
    await this.until(async () => {
      const gateway = await this.read('/api/gateway/status');
      return gateway.processState === 'running' && gateway.gatewayReady === true && gateway.transportState === 'connected';
    }, 35_000, 'Gateway did not become ready after the normal browser-mode setting');
  }

  private async read(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const reply = await this.electron.fetchHostApi({ path, method: body === undefined ? 'GET' : 'POST', body, timeoutMs: 4_000 });
    if (!reply.ok || !reply.data.ok || reply.data.status !== 200) throw new Error(`Read-only public verification unavailable: ${path}`);
    return record(reply.data.json);
  }

  private async catalog(agentId = 'main'): Promise<Identity[]> {
    const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' };
    const view = await this.read('/api/capabilities/execute', { id: 'session.management', operationId: 'sessions.list', scope: { kind: 'runtime-instance', endpoint }, target: { kind: 'runtime-endpoint' }, input: { endpoint } });
    if (!Array.isArray(view.sessions)) throw new Error('Session catalog is malformed');
    return view.sessions.map(entry => record(record(entry).sessionIdentity)).filter(identity => identity.agentId === agentId) as Identity[];
  }

  private async load(identity: Identity): Promise<Record<string, unknown>> {
    const view = await this.read('/api/capabilities/execute', { id: 'session.management', operationId: 'sessions.load', scope: { kind: 'session', identity }, target: { kind: 'session', identity }, input: { sessionIdentity: identity, sessionKey: identity.sessionKey, limit: 100 } });
    if (!isDeepStrictEqual(view.identity, identity)) throw new Error('Readback crossed the exact new session identity');
    return view;
  }

  private observeTools(tools: unknown[]): void {
    this.evidence.tools = tools.map(value => {
      const tool = record(value);
      const details = record(tool.details);
      const image = screenshotImage(tool);
      return { toolCallId: tool.toolCallId, runId: tool.runId, name: tool.name, phase: tool.phase, input: tool.input, isError: tool.isError,
        output: JSON.stringify(tool.output)?.slice(0, 16_000), details: { profile: details.profile, driver: details.driver, targetId: details.targetId, imageType: details.imageType, imageBytes: image?.bytes, imageOmitted: image?.omitted } };
    });
  }

  private async verifyScreenshot(tool: Record<string, unknown>, identity: Identity, savePath: string): Promise<void> {
    const relativePath = record(tool.input).savePath;
    if (relativePath !== savePath || tool.phase !== 'completed' || tool.isError === true) throw new Error('Screenshot save was not confirmed by the native tool call');
    // Public tool details omit savedTo; read the exact requested file through its native Agent workspace binding.
    const binary = await this.read('/api/files/binary', { id: 'workspace.file', operationId: 'files.readBinary',
      scope: { kind: 'agent', endpoint: identity.endpoint, agentId: identity.agentId }, target: { kind: 'workspace-file' },
      input: { endpoint: identity.endpoint, agentId: identity.agentId, relativePath } });
    if (binary.name !== savePath || typeof binary.data !== 'string') throw new Error('Screenshot workspace readback did not identify the requested file');
    const bytes = Buffer.from(binary.data, 'base64');
    if (bytes.length !== binary.size || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Saved screenshot is not a complete PNG file');
    const dimensions = await this.main.evaluate(async base64 => {
      const data = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const image = await createImageBitmap(new Blob([data], { type: 'image/png' }));
      const size = { width: image.width, height: image.height };
      image.close();
      return size;
    }, binary.data);
    if (dimensions.width <= 0 || dimensions.height <= 0) throw new Error('Saved screenshot decoded to an empty image');
    const attachment = join(this.electron.outputDirectory, savePath);
    await writeFile(attachment, bytes);
    this.evidence.screenshotFile = { toolCallId: tool.toolCallId, runId: tool.runId, endpoint: identity.endpoint, agentId: identity.agentId,
      savePath, readbackName: binary.name, bytes: bytes.length, ...dimensions, attachment };
  }

  private async save(): Promise<void> {
    const name = this.evidence.scenario && this.evidence.scenario !== 'multi-step' ? `iab-agent-${this.evidence.scenario}.json` : 'iab-agent.json';
    await writeFile(join(this.electron.outputDirectory, name), JSON.stringify(this.evidence, null, 2));
  }

  private async until(check: () => Promise<boolean>, timeout: number, message: string): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await delay(250); }
    throw new Error(message);
  }
}
