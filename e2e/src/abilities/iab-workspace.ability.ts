import { Ability } from '@serenity-js/core';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { UseElectron } from './use-electron.ability.js';
import type { IabTestSite } from './iab-test-site.ability.js';
import type { IabBrowserTools } from './iab-browser-tools.ability.js';
import type { IabDesktop } from './iab-desktop.ability.js';

type Pane = 'main' | 'side';
type Bounds = { x: number; y: number; width: number; height: number };
type Snapshot = {
  ownerId: string | null; revision: number; activeTabId: string | null;
  tabs: { id: string; ownerId: string; url: string; title: string }[];
  views: { tabId: string; bounds: Bounds }[];
};
type OwnedPage = { pageId: string; tabId?: string; url?: string; web?: Page; webContentsId?: number };
type Layout = { position: string | null; fullscreen: string | null; sideVisible: boolean; mainVisible: boolean };
type Baseline = { selected: Record<Pane, string | null>; layout: Layout; native: Snapshot };
type Evidence = { stage: string; outcome: 'passed' | 'failed' | 'observed'; detail?: unknown };
const endpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } as const;
type Identity = { endpoint: typeof endpoint; agentId: string; sessionKey: string };
type SessionScene = {
  expansions: { title: string; expanded: boolean }[];
  original?: { title: string; agentTitle: string };
  draftAgent?: string;
  switched: boolean;
};

const timeout = 8_000;
const openPanel = /^(打开右侧栏|Open side panel)$/i;
const restoreSize = /^(恢复工作区大小|Restore workspace)$/i;
const fullscreen = /^(全屏|Full screen)$/i;
const collapse = /^(收起工作区|Collapse workspace)$/i;
const chat = /^(聊天|Chat)$/i;
const boardMenu = /^(标签页菜单|Tab menu)$/i;
const docks = { left: /^(?:•\s*)?(左侧|Left)$/i, right: /^(?:•\s*)?(右侧|Right)$/i,
  bottom: /^(?:•\s*)?(底部|Bottom)$/i, hidden: /^(?:•\s*)?(隐藏|Hidden)$/i };

export class IabWorkspace extends Ability {
  constructor(private readonly electron: UseElectron, private readonly site: IabTestSite,
    private readonly tools: IabBrowserTools, private readonly desktop: IabDesktop) { super(); }

  private readonly owned: OwnedPage[] = [];
  private readonly evidence: Evidence[] = [];
  private stamp = '';
  private baseUrl = '';
  private boardTabId = '';
  private originalBoardTabId: string | null = null;
  private originalBoardDock?: keyof typeof docks;
  private originalPosition = 'right';
  private sessionScene?: SessionScene;
  private sessionBaseline?: Baseline;
  private ownedSession?: Identity;

  private get main() { return this.electron.page; }
  private pane(pane: Pane) { return this.main.locator(`[data-workspace-pane="${pane}"]`); }
  private tab(pageId: string) { return this.main.locator(`[role="tab"][data-page-id=${JSON.stringify(pageId)}]`); }
  private async pagePanel(pageId: string) {
    const id = await this.tab(pageId).getAttribute('aria-controls');
    if (!id) throw new Error(`Workspace tab has no real panel: ${pageId}`);
    return this.main.locator(`[id=${JSON.stringify(id)}]`);
  }

  async verify(caseId: number): Promise<void> {
    if (!Number.isInteger(caseId) || caseId < 1 || caseId > 9) throw new Error(`Unknown IAB workspace case ${caseId}`);
    this.owned.length = 0;
    this.evidence.length = 0;
    this.boardTabId = '';
    this.originalBoardTabId = null;
    this.originalBoardDock = undefined;
    this.sessionScene = undefined;
    this.sessionBaseline = undefined;
    this.ownedSession = undefined;
    this.stamp = `iab-workspace-${caseId}-${Date.now()}`;
    const failures: unknown[] = [];
    let baseline: Baseline | undefined;
    try {
      await this.main.getByTestId('chat-workspace-host').waitFor({ state: 'visible', timeout });
      if (await this.main.getByRole('dialog').or(this.main.getByRole('alertdialog')).count()) {
        throw new Error('起点要求 Chat 中没有待处理对话框；未修改已有现场');
      }
      baseline = await this.remember();
      const bridge = await this.main.evaluate(() => {
        const descriptor = Object.getOwnPropertyDescriptor(window, 'electron');
        const electron = (window as unknown as { electron: { ipcRenderer: unknown } }).electron;
        return { configurable: descriptor?.configurable === true, writable: descriptor?.writable === true,
          electronFrozen: Object.isFrozen(electron), ipcRendererFrozen: Object.isFrozen(electron.ipcRenderer) };
      });
      this.evidence.push({ stage: '公开桥可包装性（仅只读布尔事实）', outcome: 'observed', detail: bridge });
      this.evidence.push({ stage: '起点：Chat；保存两区选择、布局与native快照；#5创建自有OpenClaw空会话，不发送模型请求', outcome: 'observed', detail: baseline });
      this.baseUrl = (await this.site.prepare()).baseUrl;
      await this.normalLayout();
      const switchedSession = caseId === 5 && await this.prepareBoardSession();
      const currentLayout = await this.layout();
      this.originalPosition = currentLayout.position ?? 'right';
      if (!baseline.layout.position && !switchedSession) baseline.layout.position = this.originalPosition;
      await this.main.getByTestId('chat-composer-input').waitFor({ state: 'visible', timeout });
      await this.capture('start');
      switch (caseId) {
        case 1: await this.keepChatAfterNativeClose(); break;
        case 2: await this.keepNonBrowserOnNativeChanges(); break;
        case 3: await this.followNativeSelection(); break;
        case 4: await this.revealMainBrowser('fullscreen'); break;
        case 5: await this.revealMainBrowser('position-full'); break;
        case 6: await this.openOrdinarySideBrowser(); break;
        case 7: await this.keepCollapsedSide(); break;
        case 8: await this.keepFullscreenOnHiddenMainFollow(); break;
        case 9: await this.moveWithoutReload(); break;
      }
      this.evidence.push({ stage: `IAB工作区 #${caseId}`, outcome: 'passed' });
    } catch (error) {
      failures.push(error);
      this.evidence.push({ stage: `IAB工作区 #${caseId}`, outcome: 'failed', detail: this.describe(error) });
      try { await this.capture('failure'); } catch (captureError) { failures.push(captureError); }
    } finally {
      if (baseline) await this.cleanup(baseline, failures);
      try {
        await writeFile(join(this.electron.outputDirectory, `${this.stamp}.json`), JSON.stringify({
          caseId, operations: '新开、导航、移动、布局和正文输入使用真实UI；native switch/close仅使用既有公开IPC刺激，不冒称UI',
          evidence: this.evidence, failures: failures.map(error => this.describe(error)),
        }, null, 2));
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, `IAB工作区 #${caseId} 验证或现场恢复失败`);
  }

  private describe(error: unknown): string {
    return error instanceof AggregateError ? `${error.message}: ${error.errors.map(item => this.describe(item)).join('; ')}`
      : error instanceof Error ? error.stack ?? error.message : String(error);
  }

  private async until(condition: () => Promise<boolean>, message: string): Promise<void> {
    const deadline = Date.now() + timeout;
    do { if (await condition()) return; await delay(100); } while (Date.now() < deadline);
    throw new Error(message);
  }

  private async snapshot(): Promise<Snapshot> {
    return this.main.evaluate(async () => {
      const bridge = (window as unknown as { electron: { ipcRenderer: { invoke(channel: string): Promise<Snapshot> } } }).electron;
      return bridge.ipcRenderer.invoke('iab:snapshot');
    });
  }

  // No independent UI changes native selection without first changing Workspace selection.
  private async native(action: 'switch' | 'close', page: OwnedPage): Promise<void> {
    if (!page.tabId || !this.owned.includes(page)) throw new Error('Native stimulus must target an owned UI-created browser tab');
    const before = await this.snapshot();
    if (!before.tabs.some(tab => tab.id === page.tabId)) throw new Error('Owned native stimulus target is no longer present');
    const response = await this.main.evaluate(async command => {
      const bridge = (window as unknown as { electron: { ipcRenderer: { invoke(channel: string, request: unknown): Promise<{
        result: { resultType: string; message?: string };
      }> } } }).electron;
      return bridge.ipcRenderer.invoke('iab:command', { command });
    }, { action, tabId: page.tabId });
    this.evidence.push({ stage: `公开 native ${action}（非UI刺激）`, outcome: 'observed', detail: { tabId: page.tabId, response } });
    if (response.result.resultType === 'error') throw new Error(`Native ${action} rejected: ${response.result.message}`);
    await this.until(async () => {
      const current = await this.snapshot();
      return current.revision > before.revision && (action === 'switch' ? current.activeTabId === page.tabId : !current.tabs.some(tab => tab.id === page.tabId));
    }, `Native ${action} did not produce its public snapshot receipt`);
  }

  private async selected(pane: Pane): Promise<string | null> {
    const selected = this.pane(pane).locator('[role="tab"][aria-selected="true"]');
    if (await selected.count() > 1) throw new Error(`${pane} has multiple selected tabs`);
    return await selected.count() ? selected.getAttribute('data-page-id') : null;
  }

  private async layout(): Promise<Layout> {
    const root = this.pane('main').locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " grid ")][1]');
    return { position: await root.getAttribute('data-panel-position'), fullscreen: await root.getAttribute('data-panel-fullscreen'),
      sideVisible: await this.pane('side').isVisible(), mainVisible: await this.pane('main').isVisible() };
  }

  private async remember(): Promise<Baseline> {
    return { selected: { main: await this.selected('main'), side: await this.selected('side') }, layout: await this.layout(), native: await this.snapshot() };
  }

  private async expand(): Promise<void> {
    if (!await this.pane('side').isVisible()) await this.main.getByRole('button', { name: openPanel }).click({ timeout });
    await this.pane('side').waitFor({ state: 'visible', timeout });
  }

  private async normalLayout(): Promise<void> {
    await this.expand();
    const restore = this.pane('side').getByRole('button', { name: restoreSize });
    if (await restore.count()) await restore.click({ timeout });
    if ((await this.layout()).position === 'full') {
      // Chat is genuinely hidden in position=full; use a disposable UI page before revealing it.
      await this.files('side');
      await this.pane('side').getByRole('button', { name: collapse }).click({ timeout });
    }
    await this.pane('main').getByRole('tab', { name: chat, exact: true }).click({ timeout });
    await this.expand();
    await this.until(async () => (await this.layout()).mainVisible, 'Chat did not leave fullscreen/position=full');
  }

  private async launch(label: RegExp): Promise<void> {
    await this.pane('side').getByRole('button', { name: /^(打开页面|Open a page)$/i }).click({ timeout });
    await (await this.tools.overlay()).getByRole('menuitem', { name: label }).click({ timeout });
  }

  private async launchBrowser(expectedPane?: Pane): Promise<OwnedPage> {
    const before = await this.snapshot();
    await this.launch(/^(浏览器|Browser)$/i);
    let added: Snapshot['tabs'] = [];
    await this.until(async () => {
      added = (await this.snapshot()).tabs.filter(tab => !before.tabs.some(existing => existing.id === tab.id));
      return added.length > 0;
    }, 'Browser UI launcher did not create a new native tab');
    // Retain every positively identified new page even when the exact-one assertion fails.
    const pages = added.map(tab => ({ pageId: `iab:${tab.ownerId}:${tab.id}`, tabId: tab.id }));
    this.owned.push(...pages);
    if (pages.length !== 1) throw new Error(`UI launcher created ${pages.length} tabs instead of one`);
    const page = pages[0];
    await this.until(async () => await this.tab(page.pageId).count() === 1, 'UI-created native tab has no Workspace tab');
    const pane = expectedPane ?? await this.tab(page.pageId).evaluate(element => element.closest('[data-workspace-pane]')?.getAttribute('data-workspace-pane'));
    if (pane !== 'main' && pane !== 'side') throw new Error('New browser has no identifiable pane');
    await this.assertSelected(page.pageId, pane);
    await (await this.pagePanel(page.pageId)).locator('[data-browser-surface]').waitFor({ state: 'visible', timeout });
    return page;
  }

  private async browser(pane: Pane, suffix: string): Promise<OwnedPage> {
    const page = await this.launchBrowser();
    await this.move(page, pane);
    await this.navigate(page, `${this.baseUrl}/#${this.stamp}-${suffix}`);
    return page;
  }

  private async navigate(page: OwnedPage, url: string): Promise<void> {
    page.url = url;
    const address = (await this.pagePanel(page.pageId)).getByLabel(/^(搜索或输入网址|Search or enter a URL)$/i);
    await address.fill(url, { timeout });
    await address.press('Enter', { timeout });
    const browser = await this.electron.connectBrowser();
    await this.until(async () => {
      const matches = browser.contexts().flatMap(context => context.pages()).filter(candidate => !candidate.isClosed() && candidate.url() === url);
      if (matches.length !== 1) return false;
      page.web = matches[0];
      return await page.web.getByRole('heading', { name: 'IAB E2E Home', exact: true }).isVisible();
    }, `Owned URL has no unique loaded native WebContents: ${url}`);
    const facts = await this.electron.observeIabWebContents(url);
    if (facts.length !== 1) throw new Error('Owned URL has no unique native instance identity');
    page.webContentsId = facts[0].webContentsId;
    await this.assertBrowser(page, true);
  }

  private async select(pageId: string): Promise<void> {
    await this.tab(pageId).click({ timeout });
    await this.until(async () => await this.tab(pageId).getAttribute('aria-selected') === 'true', 'Explicit setup selection did not settle');
  }

  private async move(page: OwnedPage, pane: Pane): Promise<void> {
    const current = await this.tab(page.pageId).evaluate(element => element.closest('[data-workspace-pane]')?.getAttribute('data-workspace-pane'));
    if (current === pane) return;
    await this.tab(page.pageId).press(pane === 'main' ? 'Alt+Shift+ArrowLeft' : 'Alt+Shift+ArrowRight', { timeout });
    await this.assertSelected(page.pageId, pane);
    if (page.web) await this.assertBrowser(page, true);
  }

  private async assertSelected(pageId: string, pane: Pane): Promise<void> {
    await this.until(async () => await this.selected(pane) === pageId
      && await this.pane(pane).locator(`[role="tab"][data-page-id=${JSON.stringify(pageId)}][aria-selected="true"]`).count() === 1,
    `Automatic presentation did not select ${pageId} in ${pane}; no target-tab rescue click was used`);
  }

  private async assertBrowser(page: OwnedPage, displayed: boolean): Promise<void> {
    if (!page.url || !page.web || !page.webContentsId) throw new Error('Browser observation requires the identified UI-navigated instance');
    await this.until(async () => {
      const snapshot = await this.snapshot();
      const facts = await this.electron.observeIabWebContents(page.url!);
      if (facts.length !== 1 || facts[0].webContentsId !== page.webContentsId || page.web!.isClosed()) return false;
      const native = facts[0];
      const bounds = native.bounds;
      const content = native.contentBounds;
      const intersects = native.attached && native.visible && bounds !== null && bounds.width > 0 && bounds.height > 0
        && bounds.x < content.width && bounds.y < content.height && bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0;
      const contained = intersects && bounds!.x >= 0 && bounds!.y >= 0
        && bounds!.x + bounds!.width <= content.width && bounds!.y + bounds!.height <= content.height;
      const view = snapshot.views.find(view => view.tabId === page.tabId);
      const panelVisible = await (await this.pagePanel(page.pageId)).isVisible();
      if (!displayed) return !intersects && !view && !panelVisible;
      const slot = this.main.locator(`[data-iab-tab=${JSON.stringify(page.tabId)}][data-iab-visible="true"]:visible`);
      if (await slot.count() !== 1) return false;
      const domBounds = await slot.boundingBox();
      if (!contained || !view || !domBounds || !panelVisible || page.web!.url() !== page.url
        || !await page.web!.getByRole('heading', { name: 'IAB E2E Home', exact: true }).isVisible()
        || !await page.web!.locator('body').isVisible()) return false;
      const viewport = await this.main.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const scale = content.width / viewport.width;
      return Math.abs(scale - content.height / viewport.height) < 0.02
        && Math.abs(view.bounds.x - domBounds.x) < 3 && Math.abs(view.bounds.y - domBounds.y) < 3
        && Math.abs(view.bounds.width - domBounds.width) < 3 && Math.abs(view.bounds.height - domBounds.height) < 3
        && Math.abs(bounds!.x - domBounds.x * scale) < 4 && Math.abs(bounds!.y - domBounds.y * scale) < 4
        && Math.abs(bounds!.width - domBounds.width * scale) < 4 && Math.abs(bounds!.height - domBounds.height * scale) < 4;
    }, `Native instance, public display bounds, actual DOM body and panel did not agree: ${page.pageId}, displayed=${displayed}`);
    this.evidence.push({ stage: `真实正文/native ${displayed ? '显示' : '隐藏'}`, outcome: 'observed', detail: {
      pageId: page.pageId, url: page.url, native: await this.electron.observeIabWebContents(page.url), snapshot: await this.snapshot(),
    } });
  }

  private async assertContent(pageId: string): Promise<void> {
    const panel = await this.pagePanel(pageId);
    await panel.waitFor({ state: 'visible', timeout });
    await this.until(async () => (await panel.innerText()).trim().length > 0, 'Selected non-IAB page has no visible DOM body');
  }

  private async files(pane: Pane): Promise<OwnedPage> {
    const before = await this.main.locator('[role="tab"][data-page-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-page-id')!));
    const available = [
      { section: 'workspace', label: /^(工作区|Workspace)$/i },
      { section: 'artifacts', label: /^(产物|Artifacts)$/i },
      { section: 'changes', label: /^(变更|Changes)$/i },
    ].find(candidate => !before.some(id => {
      try { const parts = JSON.parse(id) as unknown; return Array.isArray(parts) && parts[0] === 'files' && parts.at(-1) === candidate.section; }
      catch { return false; }
    }));
    if (!available) throw new Error('No unused Files launcher remains; refusing to borrow or close pre-existing pages');
    await this.launch(available.label);
    let added: string[] = [];
    await this.until(async () => {
      added = (await this.main.locator('[role="tab"][data-page-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-page-id')!))).filter(id => !before.includes(id));
      return added.length > 0;
    }, 'Files UI did not create an owned page');
    const pages = added.map(pageId => ({ pageId }));
    this.owned.push(...pages);
    if (pages.length !== 1) throw new Error('Files launcher did not create exactly one owned page');
    await this.move(pages[0], pane);
    await this.assertSelected(pages[0].pageId, pane);
    await this.assertContent(pages[0].pageId);
    return pages[0];
  }

  private async assertLayout(expected: Layout): Promise<void> {
    await this.until(async () => JSON.stringify(await this.layout()) === JSON.stringify(expected), `Workspace layout changed: expected ${JSON.stringify(expected)}`);
  }

  private async capture(stage: string): Promise<void> {
    this.evidence.push({ stage: `桌面采集 ${stage}`, outcome: 'observed' });
    await this.desktop.capture(`${this.stamp}-${stage}`);
  }

  private async keepChatAfterNativeClose(): Promise<void> {
    const a = await this.browser('main', 'a');
    const b = await this.browser('main', 'b');
    await this.select(a.pageId);
    await this.until(async () => (await this.snapshot()).activeTabId === a.tabId, 'A did not become native current before selecting Chat');
    await this.pane('main').getByRole('tab', { name: chat, exact: true }).click({ timeout });
    await this.capture('chat-before-close');
    await this.native('close', a);
    await this.until(async () => (await this.snapshot()).activeTabId === b.tabId && await this.tab(a.pageId).count() === 0 && a.web!.isClosed(), 'Closing native-current A did not remove its UI/native instance and select native B');
    await this.assertChat();
    await this.assertBrowser(b, false);
    await this.capture('chat-kept');
  }

  private async assertChat(): Promise<void> {
    await this.until(async () => await this.pane('main').getByRole('tab', { name: chat, exact: true }).getAttribute('aria-selected') === 'true'
      && await this.main.getByTestId('chat-composer-input').isVisible() && await this.main.getByTestId('chat-stage-backdrop').isVisible(), 'Chat tab/body was stolen by a background native update');
  }

  private async keepNonBrowserOnNativeChanges(): Promise<void> {
    const a = await this.browser('main', 'a');
    const b = await this.browser('main', 'b');
    const nonBrowser = await this.files('main');
    const layout = await this.layout();
    for (const target of [a, b]) {
      await this.native('switch', target);
      await this.snapshot();
      await this.assertSelected(nonBrowser.pageId, 'main');
      await this.assertContent(nonBrowser.pageId);
      await this.assertBrowser(a, false);
      await this.assertBrowser(b, false);
      await this.assertLayout(layout);
    }
    await this.capture('non-iab-kept');
  }

  private async followNativeSelection(): Promise<void> {
    const a = await this.browser('main', 'a');
    const b = await this.browser('main', 'b');
    await this.select(a.pageId);
    await this.assertBrowser(a, true);
    await this.capture('before-native-follow');
    await this.native('switch', b);
    await this.assertSelected(b.pageId, 'main');
    await this.assertBrowser(b, true);
    await this.assertBrowser(a, false);
    await this.capture('native-follow');
  }

  private async revealMainBrowser(mode: 'fullscreen' | 'position-full'): Promise<void> {
    const a = await this.browser('main', 'provider');
    const nonBrowser = mode === 'fullscreen' ? await this.files('side') : await this.createBoardPage();
    if (mode === 'fullscreen') await this.pane('side').getByRole('button', { name: fullscreen }).click({ timeout });
    else await this.setBoardDock('hidden');
    await this.until(async () => {
      const layout = await this.layout();
      return !layout.mainVisible && layout.sideVisible && (mode === 'fullscreen' ? layout.fullscreen === 'true' : layout.position === 'full' && layout.fullscreen === 'false');
    }, `Non-IAB side page did not enter ${mode} through its real UI`);
    await this.assertSelected(nonBrowser.pageId, 'side');
    await this.assertContent(nonBrowser.pageId);
    await this.assertBrowser(a, false);
    await this.capture('side-takeover');
    const added = await this.launchBrowser('main');
    const layout = await this.layout();
    if (!layout.mainVisible || layout.fullscreen !== 'false' || layout.position === 'full') throw new Error('New provider-main browser did not automatically exit takeover');
    await this.navigate(added, `${this.baseUrl}/#${this.stamp}-revealed`);
    await this.assertSelected(added.pageId, 'main');
    await this.assertContent(nonBrowser.pageId);
    await this.capture('new-main-auto-revealed');
    await this.assertLayout(layout);
    await this.assertBrowser(added, true);
  }

  private async openOrdinarySideBrowser(): Promise<void> {
    const a = await this.browser('side', 'a');
    const layout = await this.layout();
    if (!layout.sideVisible || !layout.mainVisible || layout.fullscreen !== 'false' || layout.position === 'full') throw new Error('起点必须为普通已展开侧区');
    await this.capture('ordinary-side');
    const b = await this.launchBrowser('side');
    await this.assertLayout(layout);
    await this.navigate(b, `${this.baseUrl}/#${this.stamp}-b`);
    await this.assertSelected(b.pageId, 'side');
    await this.assertBrowser(a, false);
    await this.assertChat();
    await this.assertLayout(layout);
    await this.capture('side-auto-selected');
  }

  private async keepCollapsedSide(): Promise<void> {
    const a = await this.browser('side', 'a');
    const b = await this.browser('side', 'b');
    await this.select(a.pageId);
    await this.pane('side').getByRole('button', { name: collapse }).click({ timeout });
    await this.until(async () => !await this.pane('side').isVisible(), 'Side pane did not collapse');
    const layout = await this.layout();
    await this.capture('side-collapsed');
    await this.native('switch', b);
    await this.snapshot();
    await this.assertSelected(b.pageId, 'side');
    await this.assertLayout(layout);
    await this.assertChat();
    await this.assertBrowser(a, false);
    await this.assertBrowser(b, false);
    await this.capture('collapsed-after-native');
  }

  private async keepFullscreenOnHiddenMainFollow(): Promise<void> {
    const a = await this.browser('main', 'a');
    const b = await this.browser('main', 'b');
    await this.select(a.pageId);
    const nonBrowser = await this.files('side');
    await this.pane('side').getByRole('button', { name: fullscreen }).click({ timeout });
    await this.until(async () => (await this.layout()).fullscreen === 'true' && !await this.pane('main').isVisible(), 'Side fullscreen did not hide main browser');
    const layout = await this.layout();
    await this.capture('fullscreen-before-follow');
    await this.native('switch', b);
    await this.assertSelected(b.pageId, 'main');
    await this.assertSelected(nonBrowser.pageId, 'side');
    await this.assertContent(nonBrowser.pageId);
    await this.assertLayout(layout);
    await this.assertBrowser(a, false);
    await this.assertBrowser(b, false);
    await this.capture('fullscreen-kept');
  }

  private async moveWithoutReload(): Promise<void> {
    const page = await this.browser('main', 'move');
    const web = page.web!;
    const text = `页面内状态-${this.stamp}`;
    await web.locator('#text').fill(text, { timeout });
    await web.locator('#apply').click({ timeout });
    const timeOrigin = await web.evaluate(() => performance.timeOrigin);
    let reloads = 0;
    const navigated = () => { reloads++; };
    web.on('domcontentloaded', navigated);
    web.on('framenavigated', navigated);
    try {
      await this.capture('move-before');
      for (const pane of ['side', 'main'] as const) {
        await this.move(page, pane);
        await this.assertSelected(page.pageId, pane);
        await this.assertBrowser(page, true);
        if (web.url() !== page.url || await web.locator('#text').inputValue() !== text
          || await web.locator('#applied').innerText() !== text || await web.evaluate(() => performance.timeOrigin) !== timeOrigin || reloads !== 0) {
          throw new Error(`Moving the exact native instance to ${pane} changed URL/document/form state or reloaded it`);
        }
        await this.capture(`moved-${pane}`);
      }
      this.evidence.push({ stage: '两次移动同实例、URL、timeOrigin、页面输入及应用结果不变，无导航/重载事件', outcome: 'passed', detail: { webContentsId: page.webContentsId, url: page.url, timeOrigin, reloads } });
    } finally {
      web.off('domcontentloaded', navigated);
      web.off('framenavigated', navigated);
    }
  }

  private get board() { return this.main.locator('[data-board-root]'); }

  private async prepareBoardSession(): Promise<boolean> {
    const directory = this.main.getByTestId('agent-sessions-pane');
    await directory.waitFor({ state: 'visible', timeout });
    const headers = directory.locator('button[aria-controls][aria-expanded]');
    const expansions = await headers.evaluateAll(elements => elements.map(element => ({
      title: element.getAttribute('title')!, expanded: element.getAttribute('aria-expanded') === 'true',
    })));
    if (!expansions.length || expansions.some(item => !item.title)) throw new Error('#5 requires a loaded real Agent/session directory');
    this.sessionScene = { expansions, switched: false };
    for (const entry of expansions) if (!entry.expanded) await directory.locator(`button[aria-controls][title=${JSON.stringify(entry.title)}]`).click({ timeout });
    const current = directory.locator('button[aria-current="true"]');
    if (await current.count() > 1) throw new Error('Current session is not unique');
    if (await current.count()) {
      const original = await current.evaluate(element => ({ title: element.getAttribute('title')!,
        agentTitle: element.closest('section')?.querySelector('button[aria-controls]')?.getAttribute('title') }));
      if (!original.title || !original.agentTitle) throw new Error('Current session cannot be restored through its real directory row');
      this.sessionScene.original = { title: original.title, agentTitle: original.agentTitle };
    } else {
      if (await this.main.getByTestId('chat-composer-input').inputValue() !== '') throw new Error('Refusing to leave a nonempty original draft');
      const active = await directory.locator('section').evaluateAll(sections => sections.filter(section => section.firstElementChild?.classList.contains('bg-secondary/50'))
        .map(section => section.querySelector('button[aria-controls]')?.getAttribute('title')));
      if (active.length !== 1 || !active[0]) throw new Error('Original empty draft Agent cannot be restored through the UI');
      this.sessionScene.draftAgent = active[0];
    }
    const existingPages = await this.main.locator('[role="tab"][data-page-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-page-id')));
    if (existingPages.some(id => id !== JSON.stringify(['files', 'workspace']))) throw new Error('Switching session would discard pre-existing session-scoped Workspace pages; refusing to disturb them');
    this.sessionScene.switched = true;
    await this.createBoardSession();
    const header = directory.locator('button[aria-controls][title="OpenClaw / main"]');
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click({ timeout });
    const listId = await header.getAttribute('aria-controls');
    const candidate = directory.locator(`[id=${JSON.stringify(listId)}] > div > button[title=${JSON.stringify(this.stamp)}]`);
    await candidate.waitFor({ state: 'visible', timeout });
    await candidate.click({ timeout });
    await this.until(async () => await candidate.getAttribute('aria-current') === 'true', 'Prepared OpenClaw session was not selected');
    await this.main.getByTestId('chat-composer-input').waitFor({ state: 'visible', timeout });
    this.sessionBaseline = await this.remember();
    await this.normalLayout();
    if (!this.sessionBaseline.layout.position) this.sessionBaseline.layout.position = (await this.layout()).position;
    this.evidence.push({ stage: '#5通过真实目录选择自有OpenClaw空会话；模型发送为0', outcome: 'observed', detail: { identity: this.ownedSession } });
    return true;
  }

  private async sessionCapability(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await this.electron.fetchHostApi({ path: '/api/capabilities/execute', method: 'POST', body, timeoutMs: timeout });
    if (!reply.ok || !reply.data.ok || reply.data.status !== 200 || !reply.data.json || typeof reply.data.json !== 'object') {
      throw new Error('Board prerequisite Session capability failed; no mutation replay');
    }
    return reply.data.json as Record<string, unknown>;
  }

  private async createBoardSession(): Promise<void> {
    const input = { endpoint, agentId: 'main', endpointSessionId: this.stamp };
    const listed = await this.sessionCapability({ id: 'session.management', operationId: 'sessions.list',
      scope: { kind: 'runtime-instance', endpoint }, target: { kind: 'runtime-endpoint' }, input: { endpoint } });
    const before = listed.sessions as { sessionIdentity: Identity }[];
    if (!Array.isArray(before) || before.some(item => item.sessionIdentity.sessionKey === `agent:main:${this.stamp}`)) {
      throw new Error('Board prerequisite identity was not confirmed absent; no create was sent');
    }
    const created = await this.sessionCapability({ id: 'session.prompt', operationId: 'sessions.create',
      scope: { kind: 'agent', endpoint, agentId: 'main' }, target: { kind: 'agent', agentId: 'main' }, input });
    const identity = created.identity as Identity | undefined;
    if (!identity || identity.agentId !== 'main' || identity.sessionKey !== `agent:main:${this.stamp}`
      || identity.endpoint.kind !== endpoint.kind || identity.endpoint.runtimeAdapterId !== endpoint.runtimeAdapterId
      || identity.endpoint.runtimeInstanceId !== endpoint.runtimeInstanceId || created.sessionKey !== identity.sessionKey) {
      throw new Error('Board prerequisite create did not confirm the reserved identity; no replay or guessed deletion');
    }
    this.ownedSession = identity;
    const renamed = await this.sessionCapability({ id: 'session.management', operationId: 'sessions.rename',
      scope: { kind: 'session', identity }, target: { kind: 'session', identity }, input: { sessionIdentity: identity, label: this.stamp } });
    if (renamed.outcome !== 'succeeded') throw new Error('Board prerequisite rename was not confirmed; no replay');
    this.evidence.push({ stage: '#5公开API创建自有空Session前提（非UI、模型发送0）', outcome: 'observed', detail: { identity } });
    // Normal UI navigation refreshes the directory; all tested Workspace actions remain UI-driven.
    await this.main.getByRole('link', { name: /^(Agent|Agents)$/i, exact: true }).click({ timeout });
    await this.main.getByRole('button', { name: /^(新对话|New chat)$/i, exact: true }).click({ timeout });
    await this.main.getByTestId('chat-workspace-host').waitFor({ state: 'visible', timeout });
  }

  private async restoreSession(): Promise<void> {
    const scene = this.sessionScene;
    if (!scene) return;
    const directory = this.main.getByTestId('agent-sessions-pane');
    if (scene.switched) {
      if (scene.original) {
        const header = directory.locator(`button[aria-controls][title=${JSON.stringify(scene.original.agentTitle)}]`);
        if (await header.getAttribute('aria-expanded') !== 'true') await header.click({ timeout });
        const listId = await header.getAttribute('aria-controls');
        const row = directory.locator(`[id=${JSON.stringify(listId)}] > div > button[title=${JSON.stringify(scene.original.title)}]`);
        if (await row.count() !== 1) throw new Error('Original session row is no longer unique; refusing to select another session');
        await row.click({ timeout });
        await this.until(async () => await row.getAttribute('aria-current') === 'true', 'Original session did not become current');
      } else {
        const header = directory.locator(`button[aria-controls][title=${JSON.stringify(scene.draftAgent)}]`);
        const button = header.locator('xpath=ancestor::section[1]').getByRole('button', { name: /^(与 .+ 新建会话|New session with .+)$/i });
        await button.focus({ timeout });
        await button.press('Enter', { timeout });
        await this.until(async () => await directory.locator('button[aria-current="true"]').count() === 0
          && await this.main.getByTestId('chat-composer-input').inputValue() === '', 'Original empty draft was not restored');
      }
    }
    for (const entry of scene.expansions) {
      const header = directory.locator(`button[aria-controls][title=${JSON.stringify(entry.title)}]`);
      if (await header.getAttribute('aria-expanded') !== String(entry.expanded)) await header.click({ timeout });
    }
  }

  private async createBoardPage(): Promise<OwnedPage> {
    const existed = await this.tab('board').count() === 1;
    if (existed && !await this.pane('side').locator('[data-page-id="board"]').count()) throw new Error('Existing Board is not in side; refusing to move a pre-existing page');
    await this.launch(/^(看板|Board)$/i);
    const page = { pageId: 'board' };
    if (!existed) this.owned.push(page);
    await this.assertSelected('board', 'side');
    await this.board.waitFor({ state: 'visible', timeout });
    await this.until(async () => await this.board.getAttribute('aria-busy') === 'false', '#5 requires the prepared real OpenClaw session with ready Board; no model message is sent');
    const selected = this.board.locator('[data-board-tab-id][aria-selected="true"]');
    this.originalBoardTabId = await selected.count() ? await selected.getAttribute('data-board-tab-id') : null;
    if (this.originalBoardTabId) this.originalBoardDock = await this.readBoardDock();
    const before = await this.board.locator('[data-board-tab-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-board-tab-id')!));
    await this.board.getByRole('button', { name: /^(创建标签页|新建标签页|Create tab)$/i }).first().click({ timeout });
    const dialog = this.main.getByRole('dialog');
    await dialog.getByRole('textbox').fill(this.stamp, { timeout });
    await dialog.getByRole('button', { name: /^(保存|Save)$/i }).click({ timeout });
    await this.until(async () => await dialog.count() === 0, 'Owned Board tab creation dialog did not close');
    await this.until(async () => {
      const added = (await this.board.locator('[data-board-tab-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-board-tab-id')!))).filter(id => !before.includes(id));
      if (added.length !== 1) return false;
      this.boardTabId = added[0]; return true;
    }, 'UI did not confirm exactly one new owned Board tab');
    return page;
  }

  private async readBoardDock(): Promise<keyof typeof docks> {
    await this.board.getByRole('button', { name: boardMenu }).click({ timeout });
    try {
      for (const dock of Object.keys(docks) as (keyof typeof docks)[]) {
        if ((await this.main.getByRole('menuitem', { name: docks[dock] }).innerText()).trim().startsWith('•')) return dock;
      }
      throw new Error('Board menu has no identifiable current chat position');
    } finally { await this.main.keyboard.press('Escape'); }
  }

  private async setBoardDock(dock: keyof typeof docks): Promise<void> {
    await this.board.getByRole('button', { name: boardMenu }).click({ timeout });
    await this.main.getByRole('menuitem', { name: docks[dock] }).click({ timeout });
    const position = { left: 'right', right: 'left', bottom: 'top', hidden: 'full' }[dock];
    await this.until(async () => (await this.layout()).position === position, `Board UI did not set position=${position}`);
  }

  private async restoreBaseline(baseline: Baseline): Promise<void> {
    // All owned pages are already closed; do not create another cleanup page here.
    if ((await this.layout()).fullscreen === 'true') await this.pane('side').getByRole('button', { name: restoreSize }).click({ timeout });
    if ((await this.layout()).position === 'full') await this.pane('side').getByRole('button', { name: collapse }).click({ timeout });
    // Restore main first: restoring an original full Board must be the final reveal.
    if (baseline.selected.main) await this.select(baseline.selected.main);
    else await this.pane('main').getByRole('tab', { name: chat, exact: true }).click({ timeout });
    if (baseline.selected.side) { await this.expand(); await this.select(baseline.selected.side); }
    if (baseline.native.activeTabId) {
      const tabId = baseline.native.activeTabId;
      if (!(await this.snapshot()).tabs.some(tab => tab.id === tabId)) throw new Error('Original native tab disappeared; refusing to recreate it');
      await this.main.evaluate(async tabId => {
        const bridge = (window as unknown as { electron: { ipcRenderer: { invoke(channel: string, request: unknown): Promise<{ result: { resultType: string } }> } } }).electron;
        const result = await bridge.ipcRenderer.invoke('iab:command', { command: { action: 'switch', tabId } });
        if (result.result.resultType === 'error') throw new Error('Original native selection restore rejected');
      }, tabId);
      this.evidence.push({ stage: 'cleanup: 公开native当前页恢复（非UI）', outcome: 'observed', detail: { tabId } });
    }
    if (baseline.layout.sideVisible) {
      await this.expand();
      const isFullscreen = await this.pane('side').getByRole('button', { name: restoreSize }).count() > 0;
      if (isFullscreen !== (baseline.layout.fullscreen === 'true')) await this.pane('side').getByRole('button', { name: baseline.layout.fullscreen === 'true' ? fullscreen : restoreSize }).click({ timeout });
    } else if (await this.pane('side').isVisible()) await this.pane('side').getByRole('button', { name: collapse }).click({ timeout });
    await this.until(async () => await this.selected('main') === baseline.selected.main && await this.selected('side') === baseline.selected.side,
      'Original Workspace selections were not restored');
    if (baseline.layout.sideVisible) await this.assertLayout(baseline.layout);
    else if (await this.pane('side').isVisible() || !await this.pane('main').isVisible()) throw new Error('Original collapsed layout was not restored');
    const current = await this.snapshot();
    if (baseline.native.tabs.some(tab => !current.tabs.some(candidate => candidate.id === tab.id))) throw new Error('A pre-existing native tab was removed');
    if (baseline.native.activeTabId !== current.activeTabId) throw new Error('Original native current tab was not restored');
  }

  private async cleanup(baseline: Baseline, failures: unknown[]): Promise<void> {
    const clean = async (stage: string, action: () => Promise<void>) => {
      try { await action(); this.evidence.push({ stage: `cleanup: ${stage}`, outcome: 'passed' }); }
      catch (error) { failures.push(error); this.evidence.push({ stage: `cleanup: ${stage}`, outcome: 'failed', detail: this.describe(error) }); }
    };
    await clean('回到可操作双区', () => this.normalLayout());
    if (this.boardTabId) await clean('仅删除自有 Board Tab 并恢复原 Board 选择/dock', async () => {
      await this.select('board');
      const own = this.board.locator(`[data-board-tab-id=${JSON.stringify(this.boardTabId)}]`);
      await own.click({ timeout });
      const restoreDock = ({ right: 'left', left: 'right', top: 'bottom', full: 'hidden' } as const)[this.originalPosition as 'right' | 'left' | 'top' | 'full'];
      if (await this.readBoardDock() !== restoreDock) await this.setBoardDock(restoreDock);
      await this.board.getByRole('button', { name: boardMenu }).click({ timeout });
      await this.main.getByRole('menuitem', { name: /^(删除标签页|Delete tab)$/i }).click({ timeout });
      const dialog = this.main.getByRole('dialog');
      await dialog.getByRole('button', { name: /^(删除标签页|Delete tab)$/i }).click({ timeout });
      await this.until(async () => await dialog.count() === 0 && await own.count() === 0, 'Owned Board tab deletion was not confirmed');
      if (this.originalBoardTabId) {
        await this.board.locator(`[data-board-tab-id=${JSON.stringify(this.originalBoardTabId)}]`).click({ timeout });
        if (this.originalBoardDock && await this.readBoardDock() !== this.originalBoardDock) await this.setBoardDock(this.originalBoardDock);
      }
    });
    await clean('恢复普通布局以关闭自有页', () => this.normalLayout());
    for (const page of [...this.owned].reverse()) await clean(`仅关闭自有页 ${page.pageId}`, async () => {
      const tab = this.tab(page.pageId);
      if (await tab.count()) {
        if (await this.pane('side').locator(`[data-page-id=${JSON.stringify(page.pageId)}]`).count()) await this.expand();
        await tab.getByRole('button').click({ timeout });
      }
      await this.until(async () => await tab.count() === 0 && (!page.tabId || !(await this.snapshot()).tabs.some(tab => tab.id === page.tabId))
        && (!page.web || page.web.isClosed()), 'Owned Workspace tab/native resource did not close');
    });
    if (this.sessionBaseline) await clean('恢复借用会话原选择与布局', () => this.restoreBaseline(this.sessionBaseline!));
    if (this.sessionScene) await clean('恢复原会话/空草稿与目录展开状态', () => this.restoreSession());
    if (this.ownedSession) await clean('真实UI删除自有空Session并核对目录与原生缺席', async () => {
      const identity = this.ownedSession!;
      const listed = await this.sessionCapability({ id: 'session.management', operationId: 'sessions.list',
        scope: { kind: 'runtime-instance', endpoint }, target: { kind: 'runtime-endpoint' }, input: { endpoint } });
      const matches = Array.isArray(listed.sessions) ? (listed.sessions as { label?: string; sessionIdentity: Identity }[])
        .filter(item => item.label === this.stamp) : [];
      if (matches.length !== 1 || matches[0].sessionIdentity.sessionKey !== identity.sessionKey
        || matches[0].sessionIdentity.agentId !== identity.agentId) throw new Error('Owned Board prerequisite title/identity not confirmed; UI deletion refused');
      const directory = this.main.getByTestId('agent-sessions-pane');
      const header = directory.locator('button[aria-controls][title="OpenClaw / main"]');
      const wasExpanded = await header.getAttribute('aria-expanded') === 'true';
      if (!wasExpanded) await header.click({ timeout });
      const listId = await header.getAttribute('aria-controls');
      const row = directory.locator(`[id=${JSON.stringify(listId)}] > div > button[title=${JSON.stringify(this.stamp)}]`);
      if (await row.count() !== 1) throw new Error('Owned Board prerequisite UI row is not unique; deletion refused');
      const menu = row.locator('..').locator('button[aria-label]');
      await menu.focus({ timeout });
      await menu.press('Enter', { timeout });
      await this.main.getByRole('menuitem', { name: /^(删除|Delete)$/i }).click({ timeout });
      const dialog = this.main.getByRole('dialog', { name: `删除 ${this.stamp}`, exact: true })
        .or(this.main.getByRole('dialog', { name: `Delete ${this.stamp}`, exact: true }));
      await dialog.getByRole('button', { name: /^(确认删除|Confirm Delete)$/i }).click({ timeout });
      await this.until(async () => await this.main.getByRole('dialog').count() === 0, 'Owned Board prerequisite delete outcome unresolved; no replay or API fallback');
      await this.until(async () => await row.count() === 0, 'Owned Board prerequisite remained in Renderer directory');
      await this.until(async () => {
        const current = await this.sessionCapability({ id: 'session.management', operationId: 'sessions.list',
          scope: { kind: 'runtime-instance', endpoint }, target: { kind: 'runtime-endpoint' }, input: { endpoint } });
        return Array.isArray(current.sessions) && !(current.sessions as { sessionIdentity: Identity }[])
          .some(item => item.sessionIdentity.agentId === identity.agentId && item.sessionIdentity.sessionKey === identity.sessionKey);
      }, 'Owned Board prerequisite Session remained after UI deletion');
      this.evidence.push({ stage: 'cleanup: 自有Session UI与native删除确认', outcome: 'observed', detail: { identity, dialogCount: 0, uiRowCount: 0, nativePresent: false } });
      if (!wasExpanded) await header.click({ timeout });
    });
    await clean('恢复并核对原两区选择、布局与 native 页', () => this.restoreBaseline(baseline));
  }
}
