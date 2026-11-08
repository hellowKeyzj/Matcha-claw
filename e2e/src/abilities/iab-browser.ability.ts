import { Ability } from '@serenity-js/core';
import type { Page } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { UseElectron } from './use-electron.ability.js';
import type { IabTestSite } from './iab-test-site.ability.js';
import type { IabBrowserTools } from './iab-browser-tools.ability.js';
import type { IabDesktop } from './iab-desktop.ability.js';
import { UI_TIMEOUT_MS } from '../config/electron.js';

export class IabBrowser extends Ability {
  constructor(private readonly electron: UseElectron, private readonly site: IabTestSite,
    private readonly tools: IabBrowserTools, private readonly desktop: IabDesktop) { super(); }

  private baseUrl = '';
  private initialTabs: string[] = [];
  private ownTab = '';
  private ownPage?: Page;
  private wasFullscreen = false;
  private openedPanel = false;
  private readonly results: { feature: string; outcome: 'passed' | 'failed'; error?: string }[] = [];

  private get main() { return this.electron.page; }
  private get surface() { return this.main.locator('[data-browser-surface]:visible'); }
  private get address() { return this.surface.getByLabel(/^(搜索或输入网址|Search or enter a URL)$/); }
  private get workspace() { return this.main.locator('[data-workspace-pane="side"]'); }
  private get tabs() { return this.workspace.locator('[role="tab"][data-page-id^="iab:"]'); }

  async verifyAll(): Promise<{ passed: number; failed: number }> {
    const prepared = await this.site.prepare();
    this.baseUrl = prepared.baseUrl;
    const settings = await this.electron.fetchHostApi({ path: '/api/settings', method: 'GET', timeoutMs: 4_000 });
    const browserMode = settings.ok && settings.data.ok && settings.data.status === 200
      ? (settings.data.json as { browserMode?: unknown } | undefined)?.browserMode : undefined;
    if (typeof browserMode !== 'string' || !['iab', 'relay', 'native', 'off'].includes(browserMode)) throw new Error('Browser mode baseline is unavailable; no settings were changed');
    const panel = this.main.getByRole('button', { name: /^(打开右侧栏|Open side panel)$/ });
    this.openedPanel = await panel.isVisible();
    this.initialTabs = await this.tabs.evaluateAll(elements => elements.map(element => element.getAttribute('data-page-id') ?? ''));
    const initialPages = await this.workspace.locator('[role="tab"][aria-selected="true"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-page-id')));
    if (initialPages.length > 1) throw new Error('Initial side pane has multiple selected pages; no UI was changed');
    this.wasFullscreen = await this.workspace.getByRole('button', { name: /^(恢复工作区大小|Restore workspace)$/ }).count() > 0;
    const checks: [string, () => Promise<void>][] = [
      ['地址导航、普通链接、前进后退、刷新', () => this.verifyNavigation()],
      ['新标签链接、前台激活、标签切换与关闭', () => this.verifyTabs()],
      ['中文输入、键盘复制粘贴、按钮、勾选和下拉', () => this.verifyInputs()],
      ['滚动及底部点击坐标', () => this.verifyScroll()],
      ['Ctrl+F 命中数量、前后匹配和无结果', async () => { await this.home(); await this.tools.verifyFind(await this.web()); }],
      ['缩放、缩小和重置', async () => { await this.home(); await this.tools.verifyZoom(); }],
      ['历史记录搜索并重新打开页面', async () => {
        await this.navigate(this.baseUrl + '/second');
        await this.waitTitle('IAB E2E Second');
        // Product records settled visits after 500ms; don't navigate away during its debounce.
        await delay(650);
        await this.home();
        await this.tools.reopenHistory(this.baseUrl + '/second');
        await this.waitTitle('IAB E2E Second');
      }],
      ['文件下载、实际文件名和内容、下载记录', () => this.verifyDownload(prepared.downloadText)],
      ['原生文件选择上传、文件名及内容', () => this.verifyUpload(prepared.uploadPath)],
      ['登录 Cookie 和网站存储保持、刷新', () => this.verifyLogin()],
      ['切换会话后登录保持及标签不串页', () => this.verifySessionSwitch()],
      ['拖动中间分隔线后的内容和点击位置', () => this.verifyDivider()],
      ['拖动窗口边框后的完整合成画面', async () => { await this.home(); await this.desktop.resizeAndRestore(); await this.verifyButton('窗口调整后中文'); }],
      ['中文关键词搜索与真实搜索页面', () => this.verifySearch()],
      ['最后清除共享 Cookie 和网站存储', () => this.verifyClearData()],
    ];
    try {
      this.main.setDefaultTimeout(5_000);
      if (this.openedPanel) await panel.click();
      await this.workspace.waitFor();
      for (let index = 0; index < checks.length; index++) {
        const [feature, action] = checks[index];
        try {
          await action();
          this.results.push({ feature, outcome: 'passed' });
        } catch (error) {
          const describe = (value: unknown): string => value instanceof AggregateError
            ? `${value.message}: ${value.errors.map(describe).join('; ')}`
            : value instanceof Error ? `${value.message}${value.cause ? `; cause: ${describe(value.cause)}` : ''}` : String(value);
          this.results.push({ feature, outcome: 'failed', error: describe(error).slice(0, 6_000) });
          await this.main.screenshot({ path: join(this.electron.outputDirectory, `iab-${index + 1}-failure-shell.png`), timeout: 3_000 }).catch(() => undefined);
        }
        await writeFile(join(this.electron.outputDirectory, 'iab-checks.json'), JSON.stringify({ browserMode, results: this.results, agentModelOperation: 'not-executed' }, null, 2));
      }
    } finally {
      const failures: unknown[] = [];
      try { if (await this.surface.count()) await this.tools.dismissMenu(); } catch (error) { failures.push(error); }
      try {
        const current = await this.tabs.evaluateAll(elements => elements.map(element => element.getAttribute('data-page-id') ?? ''));
        for (const id of current.filter(id => !this.initialTabs.includes(id))) {
          try {
            const tab = this.workspace.locator(`[role="tab"][data-page-id=${JSON.stringify(id)}]`);
            await tab.getByRole('button').click();
            await this.until(async () => await tab.count() === 0, `Owned browser tab did not close: ${id}`);
          } catch (error) { failures.push(error); }
        }
      } catch (error) { failures.push(error); }
      try {
        if (initialPages[0]) {
          const original = this.workspace.locator(`[role="tab"][data-page-id=${JSON.stringify(initialPages[0])}]`);
          await original.click();
          await this.until(async () => await original.getAttribute('aria-selected') === 'true', 'Original side pane page was not restored');
        }
      } catch (error) { failures.push(error); }
      try {
        const restore = this.workspace.getByRole('button', { name: /^(恢复工作区大小|Restore workspace)$/ });
        if (this.wasFullscreen !== (await restore.count() > 0)) {
          await this.workspace.getByRole('button', { name: this.wasFullscreen ? /^(全屏|Full screen)$/ : /^(恢复工作区大小|Restore workspace)$/ }).click();
          await this.until(async () => this.wasFullscreen === (await restore.count() > 0), 'Original workspace size was not restored');
        }
      } catch (error) { failures.push(error); }
      try {
        if (this.openedPanel && await this.workspace.isVisible()) await this.workspace.getByRole('button', { name: /^(收起工作区|Collapse workspace)$/ }).click();
        if (!this.openedPanel && !await this.workspace.isVisible()) await panel.click();
        await this.until(async () => await this.workspace.isVisible() === !this.openedPanel, 'Original workspace visibility was not restored');
      } catch (error) { failures.push(error); }
      this.main.setDefaultTimeout(UI_TIMEOUT_MS);
      if (failures.length) {
        this.results.push({ feature: '恢复本次创建的浏览器标签', outcome: 'failed', error: failures.map(String).join('; ') });
        await writeFile(join(this.electron.outputDirectory, 'iab-checks.json'), JSON.stringify({ browserMode, results: this.results, agentModelOperation: 'not-executed' }, null, 2));
      }
    }
    return { passed: this.results.filter(result => result.outcome === 'passed').length, failed: this.results.filter(result => result.outcome === 'failed').length };
  }

  private async launchTab(): Promise<void> {
    const before = await this.tabs.evaluateAll(elements => elements.map(element => element.getAttribute('data-page-id')));
    await this.workspace.getByRole('button', { name: /^(打开页面|Open a page)$/ }).click();
    await (await this.tools.overlay()).getByRole('menuitem', { name: /^(浏览器|Browser)$/ }).click();
    await this.until(async () => (await this.tabs.count()) === before.length + 1, 'Browser launcher did not add a tab');
    const added = (await this.tabs.evaluateAll(elements => elements.map(element => element.getAttribute('data-page-id')))).filter(id => !before.includes(id));
    if (added.length !== 1 || !added[0]) throw new Error('Browser launcher did not create one identifiable tab');
    this.ownTab = added[0];
  }

  private async selectOwn(): Promise<void> {
    if (!this.ownTab) await this.launchTab();
    await this.workspace.locator(`[role="tab"][data-page-id="${this.ownTab}"]`).click();
    await this.surface.waitFor();
  }

  private async navigate(url: string): Promise<void> {
    await this.selectOwn();
    await this.tools.dismissMenu();
    await this.address.fill(url);
    await this.address.press('Enter');
  }

  private async home(): Promise<void> {
    await this.navigate(this.baseUrl + '/');
    await this.waitTitle('IAB E2E Home');
    const page = await this.web();
    await page.waitForLoadState('domcontentloaded');
    await this.until(async () => await this.surface.getByRole('button', { name: /^(重新加载|Reload)$/ }).getAttribute('aria-busy') !== 'true', 'Page loading did not settle');
    this.ownPage = page;
  }

  private async web(url = this.baseUrl + '/'): Promise<Page> {
    const browser = await this.electron.connectBrowser();
    let result: Page | undefined;
    await this.until(async () => {
      const matches = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === url && !page.isClosed());
      if (matches.length !== 1) return false;
      result = matches[0]; return true;
    }, `Expected exactly one existing IAB page for ${url}`);
    return result!;
  }

  private async waitTitle(title: string): Promise<void> {
    await this.until(async () => {
      const selected = this.workspace.locator('[role="tab"][data-page-id^="iab:"][aria-selected="true"]');
      return (await selected.count()) === 1 && (await selected.getByText(title, { exact: true }).count()) === 1;
    }, `Active browser tab did not become ${title}`);
  }

  private async verifyNavigation(): Promise<void> {
    await this.launchTab();
    await this.home();
    const web = await this.web();
    await web.locator('#ordinary').click();
    await web.waitForURL(this.baseUrl + '/second');
    await this.waitTitle('IAB E2E Second');
    await this.surface.getByRole('button', { name: /^(后退|Back)$/ }).click();
    await web.waitForURL(this.baseUrl + '/');
    await this.surface.getByRole('button', { name: /^(前进|Forward)$/ }).click();
    await web.waitForURL(this.baseUrl + '/second');
    const loaded = web.waitForEvent('domcontentloaded');
    await this.surface.getByRole('button', { name: /^(重新加载|Reload)$/ }).click();
    await loaded;
    await this.waitTitle('IAB E2E Second');
    await this.desktop.capture('iab-navigation');
  }

  private async verifyTabs(): Promise<void> {
    await this.home();
    const parent = await this.web();
    const count = await this.tabs.count();
    await parent.locator('#new-tab').click();
    await this.until(async () => (await this.tabs.count()) === count + 1, 'New-tab link did not add a browser tab');
    await this.waitTitle('IAB E2E Child');
    const child = await this.web(this.baseUrl + '/child');
    if (!(await child.evaluate(() => document.visibilityState === 'visible'))) throw new Error('Child tab was not brought to the foreground');
    await this.selectOwn();
    await this.waitTitle('IAB E2E Home');
    if ((await parent.locator('#text').inputValue()) !== '') throw new Error('Parent unexpectedly inherited another tab input');
    const childTab = this.tabs.filter({ has: this.main.getByText('IAB E2E Child', { exact: true }) });
    await childTab.click();
    await this.waitTitle('IAB E2E Child');
    await childTab.getByRole('button').click();
    await this.until(async () => (await this.tabs.count()) === count && child.isClosed(), 'Closing the child tab did not close its real page');
    await this.selectOwn();
  }

  private async verifyButton(text: string): Promise<void> {
    const web = await this.web();
    await web.locator('#text').fill(text);
    await web.locator('#apply').click();
    await this.until(async () => (await web.locator('#applied').textContent()) === text, 'Page button did not apply the Chinese input');
  }

  private async verifyInputs(): Promise<void> {
    await this.home();
    const web = await this.web();
    await this.verifyButton('内置浏览器中文输入');
    await web.locator('#text').press('Control+a');
    await web.locator('#text').press('Control+c');
    await web.locator('#paste').click();
    await web.locator('#paste').press('Control+v');
    if ((await web.locator('#paste').inputValue()) !== '内置浏览器中文输入') throw new Error('Keyboard copy and paste did not preserve Chinese text');
    await web.locator('#check').check();
    if (!(await web.locator('#check').isChecked())) throw new Error('Checkbox did not change');
    await web.locator('#choice').selectOption('two');
    if ((await web.locator('#choice').inputValue()) !== 'two') throw new Error('Select did not change');
    await this.desktop.capture('iab-inputs');
  }

  private async verifyScroll(): Promise<void> {
    await this.home();
    const web = await this.web();
    await web.locator('#text').click();
    await web.keyboard.press('Escape');
    await web.mouse.wheel(0, 1500);
    await this.until(async () => web.evaluate(() => scrollY > 0), 'Real wheel did not scroll the IAB page');
    await web.locator('#bottom').click();
    if ((await web.locator('#bottom-result').textContent()) !== 'clicked') throw new Error('Scrolled bottom button did not receive the click');
    await this.desktop.capture('iab-scroll');
  }

  private async verifyDownload(expected: string): Promise<void> {
    await this.home();
    const directory = await this.electron.prepareDownloadDirectory();
    const before = new Set(await readdir(directory));
    await (await this.web()).locator('#download').click();
    let filename = '';
    await this.until(async () => {
      const created = (await readdir(directory)).filter(name => !before.has(name) && name === this.site.downloadFilename);
      if (created.length !== 1) return false;
      filename = created[0];
      return (await readFile(join(directory, filename), 'utf8')) === expected;
    }, 'Download did not create one new correctly named file with the expected bytes', 10_000);
    await this.tools.verifyDownloads(filename);
    await writeFile(join(this.electron.outputDirectory, 'iab-download.json'), JSON.stringify({ filename, contentMatches: true, utf8Bytes: Buffer.byteLength(expected), directory }, null, 2));
  }

  private async verifyUpload(uploadPath: string): Promise<void> {
    await this.home();
    const web = await this.web();
    await web.locator('#upload').click({ noWaitAfter: true });
    const pickerTitle = await this.main.evaluate(() => navigator.language.startsWith('zh') ? '打开' : 'Open');
    await this.electron.completeNativeFilePicker(uploadPath, pickerTitle);
    const expected = basename(uploadPath) + ': ' + await readFile(uploadPath, 'utf8');
    await this.until(async () => (await web.locator('#uploaded').textContent()) === expected, 'Native upload did not expose the selected filename and actual contents');
  }

  private async verifyLogin(): Promise<void> {
    await this.navigate(this.baseUrl + '/login');
    const web = await this.web(this.baseUrl + '/login');
    await web.locator('#username').fill('iaptester');
    await web.locator('#password').fill('fixture-only');
    await web.getByRole('button', { name: '登录', exact: true }).click();
    await web.waitForURL(this.baseUrl + '/account?seed=1');
    await this.assertLogin(web, 'authenticated', 'present');
    const loaded = web.waitForEvent('domcontentloaded');
    await this.surface.getByRole('button', { name: /^(重新加载|Reload)$/ }).click();
    await loaded;
    await this.assertLogin(web, 'authenticated', 'present');
  }

  private async verifySessionSwitch(): Promise<void> {
    await this.navigate(this.baseUrl + '/account');
    const web = await this.web(this.baseUrl + '/account');
    await this.assertLogin(web, 'authenticated', 'present');
    const pane = this.main.getByTestId('agent-sessions-pane');
    await pane.waitFor({ state: 'visible' });
    const input = this.main.getByTestId('chat-composer-input');
    const initialInput = await input.inputValue();
    const collapsedIds = await pane.locator('button[aria-expanded="false"][aria-controls]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-controls')!));
    const collapsed = collapsedIds.map(id => pane.locator(`button[aria-controls=${JSON.stringify(id)}]`));
    const failures: unknown[] = [];
    let restoreSelection: (() => Promise<void>) | undefined;
    try {
      for (const group of collapsed) await group.click();
      const groups = await pane.locator('section').evaluateAll(sections => sections.map(section => {
        const header = section.querySelector('button[aria-controls]');
        const listId = header?.getAttribute('aria-controls') ?? '';
        return {
          listId,
          active: section.firstElementChild?.classList.contains('bg-secondary/70') ?? false,
          sessions: Array.from(document.getElementById(listId)?.querySelectorAll('button[title]') ?? [], button => ({
            title: button.getAttribute('title') ?? '', current: button.getAttribute('aria-current') === 'true',
          })),
        };
      }));
      const current = groups.flatMap(group => group.sessions.filter(session => session.current).map(session => ({ ...session, listId: group.listId })));
      const sectionFor = (id: string) => pane.locator(`button[aria-controls=${JSON.stringify(id)}]`).locator('xpath=ancestor::section[1]');
      if (current.length === 1) {
        const original = sectionFor(current[0].listId).locator(`button[title=${JSON.stringify(current[0].title)}]:not([aria-controls])`);
        if (await original.count() !== 1) throw new Error('Original session is not uniquely identifiable');
        restoreSelection = async () => {
          await original.click();
          await this.until(async () => await original.getAttribute('aria-current') === 'true'
            && await pane.locator('button[aria-current="true"]').count() === 1
            && await input.inputValue() === initialInput, 'Original session and composer draft were not restored');
        };
      } else {
        const active = groups.filter(group => group.active);
        if (current.length || active.length !== 1 || initialInput !== '') throw new Error('Initial draft scope cannot be restored safely');
        const section = sectionFor(active[0].listId);
        const newDraft = section.getByRole('button', { name: /^(与 .+ 新建会话|New session with .+)$/ });
        if (await newDraft.count() !== 1 || !await newDraft.isEnabled()) throw new Error('Initial draft has no unique enabled UI restore action');
        restoreSelection = async () => {
          await section.locator('button[aria-controls]').hover();
          await newDraft.click();
          await this.until(async () => await pane.locator('button[aria-current="true"]').count() === 0
            && await input.inputValue() === ''
            && await section.locator(':scope > div').first().evaluate(element => element.classList.contains('bg-secondary/70')), 'Initial empty draft scope was not restored');
        };
      }
      const available = groups.map(group => ({ ...group, sessions: group.sessions.filter(session => session.title
        && group.sessions.filter(other => other.title === session.title).length === 1) }));
      const target = available.find(group => group.sessions.length >= 2 && (!current.length || group.listId === current[0].listId));
      if (!target) throw new Error('Session switching requires two distinct, uniquely titled existing sessions; no model message was sent');
      const initialTabs = (await this.tabs.evaluateAll(elements => elements.map(element => element.getAttribute('data-page-id')))).sort();
      for (const session of target.sessions.slice(0, 2)) {
        const row = sectionFor(target.listId).locator(`button[title=${JSON.stringify(session.title)}]:not([aria-controls])`);
        await row.click();
        await this.until(async () => await row.getAttribute('aria-current') === 'true'
          && await pane.locator('button[aria-current="true"]').count() === 1, 'Selected existing session did not become uniquely current');
        await this.selectOwn();
        if (await this.web(this.baseUrl + '/account') !== web) throw new Error('Session switching replaced the identified browser page');
        const tabs = (await this.tabs.evaluateAll(elements => elements.map(element => element.getAttribute('data-page-id')))).sort();
        if (JSON.stringify(tabs) !== JSON.stringify(initialTabs)) throw new Error('Session switching changed the shared UI-created browser tabs');
        const loaded = web.waitForEvent('domcontentloaded');
        await this.surface.getByRole('button', { name: /^(重新加载|Reload)$/ }).click();
        await loaded;
        await this.assertLogin(web, 'authenticated', 'present');
        await this.until(async () => web.evaluate(() => document.visibilityState === 'visible'), 'Selected browser page was not visible after session switching');
      }
      await this.desktop.capture('iab-session-switch');
      await writeFile(join(this.electron.outputDirectory, 'iab-session-switch.json'), JSON.stringify({ existingSessionsChecked: 2, sameBrowserPage: true, loginAndStoragePreserved: true, modelMessageSent: false }, null, 2));
    } catch (error) { failures.push(error); }
    finally {
      try { await restoreSelection?.(); } catch (error) { failures.push(error); }
      try { await this.selectOwn(); } catch (error) { failures.push(error); }
      for (const group of collapsed) {
        try {
          if (await group.getAttribute('aria-expanded') === 'true') await group.click();
          await this.until(async () => await group.getAttribute('aria-expanded') === 'false', 'Original Agent expansion was not restored');
        } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'IAB session switching/restoration failed');
  }

  private async verifyDivider(): Promise<void> {
    await this.home();
    const restore = this.workspace.getByRole('button', { name: /^(恢复工作区大小|Restore workspace)$/ });
    if (await restore.count()) await restore.click();
    const handle = this.main.getByTestId('chat-side-panel-resizer');
    const box = await handle.boundingBox();
    if (!box) throw new Error('Docked browser divider is not visible');
    const before = await this.workspace.boundingBox();
    try {
      await this.main.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await this.main.mouse.down();
      await this.main.mouse.move(box.x - 90, box.y + box.height / 2, { steps: 12 });
      await this.main.mouse.up();
      const after = await this.workspace.boundingBox();
      if (!before || !after || Math.abs(after.width - before.width) < 30) throw new Error('Dragging the divider did not resize the workspace');
      await this.verifyButton('分隔线调整后中文');
      await this.desktop.capture('iab-divider-dragged');
    } finally {
      await this.main.mouse.up();
      const current = await handle.boundingBox();
      if (current) {
        await this.main.mouse.move(current.x + current.width / 2, current.y + current.height / 2);
        await this.main.mouse.down();
        try { await this.main.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 }); }
        finally { await this.main.mouse.up(); }
      }
    }
  }

  private async verifySearch(): Promise<void> {
    await this.navigate('内置浏览器 中文搜索');
    await this.until(async () => (await this.address.inputValue()).startsWith('https://www.bing.com/search?q='), 'Chinese keywords were not sent to the real default search engine');
    const page = this.ownPage;
    if (!page) throw new Error('Search requires the previously identified owned browser page');
    await this.until(async () => {
      const url = new URL(page.url());
      return url.hostname === 'www.bing.com' && url.pathname === '/search' && url.searchParams.get('q') === '内置浏览器 中文搜索';
    }, 'Search did not navigate this exact IAB page with the expected Chinese query');
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
    const failures: unknown[] = [];
    try { await page.locator('#b_results').waitFor({ timeout: 15_000 }); } catch (error) { failures.push(error); }
    try {
      const observed = await page.evaluate(() => {
        const result = document.getElementById('b_results');
        const ancestors = [];
        for (let element = result; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          ancestors.push({ tag: element.tagName, id: element.id, display: style.display, visibility: style.visibility, width: rect.width, height: rect.height });
        }
        return { url: location.href, title: document.title, resultCount: result?.querySelectorAll('li.b_algo').length ?? 0, ancestors };
      });
      await writeFile(join(this.electron.outputDirectory, 'iab-search.json'), JSON.stringify(observed, null, 2));
      await this.desktop.capture('iab-chinese-search');
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'IAB real Chinese search verification failed');
  }

  private async verifyClearData(): Promise<void> {
    await this.navigate(this.baseUrl + '/account');
    const web = await this.web(this.baseUrl + '/account');
    await this.assertLogin(web, 'authenticated', 'present');
    await this.tools.clearSiteData();
    await this.navigate(this.baseUrl + '/account');
    await this.assertLogin(web, 'anonymous', 'missing');
    await this.desktop.capture('iab-site-data-cleared');
  }

  private async assertLogin(web: Page, auth: string, storage: string): Promise<void> {
    await this.until(async () => (await web.locator('#auth').textContent()) === auth && (await web.locator('#storage').textContent()) === storage, `Test-site login/storage did not become ${auth}/${storage}`);
  }

  private async until(condition: () => Promise<boolean>, message: string, timeout = 5_000): Promise<void> {
    const deadline = Date.now() + timeout;
    do { if (await condition()) return; await delay(100); } while (Date.now() < deadline);
    throw new Error(message);
  }
}
