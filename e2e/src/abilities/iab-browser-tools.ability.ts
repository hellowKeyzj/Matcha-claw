import { Ability } from '@serenity-js/core';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { UseElectron } from './use-electron.ability.js';

const timeout = 15_000;
const moreLabel = /^(更多(?:选项)?|More(?: options)?)$/i;
const addressLabel = /地址|网址|Address|URL/i;
const findLabel = /^(在页面中查找|Find in page)$/i;

async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, description: string): Promise<T> {
  const deadline = Date.now() + timeout;
  let actual: T;
  do {
    actual = await read();
    if (matches(actual)) return actual;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`${description}; observed ${JSON.stringify(actual)}`);
}

export class IabBrowserTools extends Ability {
  private browser?: ReturnType<UseElectron['connectBrowser']>;

  constructor(private readonly electron: UseElectron) { super(); }

  private get surface() { return this.electron.page.locator('[data-browser-surface]:visible'); }
  private get address() { return this.surface.getByLabel(addressLabel); }
  private get more() { return this.surface.getByRole('button', { name: moreLabel }); }

  private connectBrowser() {
    return this.browser ??= this.electron.connectBrowser();
  }

  async overlay(): Promise<Page> {
    const browser = await this.connectBrowser();
    const pages = await waitFor(async () => browser.contexts().flatMap(context => context.pages())
      .filter(page => page.url().endsWith('/iab/overlay/index.html')), pages => pages.length > 0,
    'IAB overlay WebContentsView did not appear in the owned Electron CDP connection');
    if (pages.length !== 1) throw new Error(`IAB expected one overlay WebContentsView, found ${pages.length}`);
    return pages[0];
  }

  async dismissMenu(): Promise<void> {
    if (await this.more.getAttribute('aria-expanded') !== 'true') return;
    const overlay = await this.overlay();
    const submenu = overlay.getByRole('dialog', { name: /^(清除浏览数据|Clear browsing data)$/i });
    if (await submenu.count()) {
      await overlay.keyboard.press('Escape');
      await waitFor(() => submenu.count(), value => value === 0, 'IAB Escape did not dismiss the clear-data submenu');
    }
    await overlay.keyboard.press('Escape');
    await waitFor(() => overlay.getByRole('dialog', { name: moreLabel }).count(), value => value === 0, 'IAB Escape did not remove the more menu');
    await waitFor(() => this.more.getAttribute('aria-expanded'), value => value === 'false', 'IAB Escape did not dismiss the more menu');
  }

  private async openMenu() {
    await this.dismissMenu();
    await this.more.click({ timeout });
    await waitFor(() => this.more.getAttribute('aria-expanded'), value => value === 'true', 'IAB more menu did not open');
    const overlay = await this.overlay();
    const menu = overlay.getByRole('dialog', { name: moreLabel });
    // The cached overlay Page survives hide(); its existence does not mean the menu is open.
    await menu.waitFor({ state: 'visible', timeout });
    return menu;
  }

  async verifyFind(webPage: Page): Promise<void> {
    await webPage.locator('#text').click();
    await this.electron.pressFindShortcut(webPage.url());
    const find = this.surface.getByRole('search', { name: findLabel });
    await find.waitFor({ state: 'visible', timeout });
    const input = find.getByLabel(findLabel);
    const status = find.getByRole('status');
    await input.fill('IAB-FIND-TOKEN');
    await waitFor(() => status.innerText(), value => value === '1/3', 'IAB find did not select the first of three matches');
    await webPage.screenshot({ path: join(this.electron.outputDirectory, `iab-find-${Date.now()}.png`), timeout: 5_000 });
    await find.getByRole('button', { name: /^(下一|Next)/i }).click();
    await waitFor(() => status.innerText(), value => value === '2/3', 'IAB find next did not select the second match');
    await find.getByRole('button', { name: /^(上一|Previous)/i }).click();
    await waitFor(() => status.innerText(), value => value === '1/3', 'IAB find previous did not return to the first match');
    await input.fill('IAB-FIND-NO-MATCH');
    await waitFor(() => status.innerText(), value => value === '0/0', 'IAB find did not report zero matches');
    await input.press('Escape');
    await waitFor(() => find.count(), value => value === 0, 'IAB Escape did not remove the find bar');
  }

  async verifyZoom(): Promise<void> {
    const url = await this.address.inputValue();
    if (!/^https?:\/\//.test(url)) throw new Error('IAB zoom requires an active test-site URL in the visible address field');
    const browser = await this.connectBrowser();
    const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === url);
    if (pages.length !== 1) throw new Error(`IAB zoom expected one web Page at ${url}, found ${pages.length}`);
    const webPage = pages[0];
    const menu = await this.openMenu();
    const zoom = menu.getByRole('group', { name: /^(缩放|Zoom)$/i });
    const output = zoom.locator('output');
    await waitFor(() => output.innerText(), value => value === '100%', 'IAB zoom did not start at 100%');
    const metrics = () => webPage.evaluate(() => ({ ratio: window.devicePixelRatio, width: window.innerWidth }));
    const baseline = await metrics();
    if (baseline.ratio <= 0 || baseline.width <= 0) throw new Error('IAB web viewport has no measurable zoom baseline');

    for (const restore of [/^(缩小|Zoom out)$/i, /^(重置缩放|Reset zoom)$/i]) {
      await zoom.getByRole('button', { name: /^(放大|Zoom in)$/i }).click();
      const enlarged = await waitFor(() => output.innerText(), value => /^\d+%$/.test(value) && Number.parseInt(value) > 100,
        'IAB zoom in did not increase the displayed percentage');
      const factor = Number.parseInt(enlarged) / 100;
      await waitFor(metrics, value => Math.abs(value.ratio / baseline.ratio - factor) < .03
        && Math.abs(value.width * factor / baseline.width - 1) < .03,
      `IAB displayed ${enlarged} without matching web pixel ratio and visual viewport scaling`);
      await zoom.getByRole('button', { name: restore }).click();
      await waitFor(() => output.innerText(), value => value === '100%', `IAB ${restore.source} did not restore 100%`);
      await waitFor(metrics, value => Math.abs(value.ratio / baseline.ratio - 1) < .03
        && Math.abs(value.width / baseline.width - 1) < .03, 'IAB web viewport did not return to its 100% baseline');
    }
    await this.dismissMenu();
  }

  async reopenHistory(url: string): Promise<void> {
    const menu = await this.openMenu();
    await menu.getByRole('button', { name: /^(历史记录|History)$/i }).click();
    const history = this.surface.getByRole('region', { name: /^(历史记录|History)$/i });
    await history.waitFor({ state: 'visible', timeout });
    await history.getByRole('search').getByLabel(/搜索|Search/i).fill(url);
    await history.getByTitle(url, { exact: true }).click({ timeout });
    await waitFor(() => this.address.inputValue(), value => value === url, 'IAB history did not restore the exact URL in the address field');
  }

  async verifyDownloads(filename: string): Promise<void> {
    const menu = await this.openMenu();
    await menu.getByRole('button', { name: /^(下载|Downloads)$/i }).click();
    const downloads = this.surface.getByRole('region', { name: /^(下载记录|Download history)$/i });
    await downloads.waitFor({ state: 'visible', timeout });
    await downloads.getByRole('search').getByLabel(/搜索|Search/i).fill(filename);
    const row = downloads.getByRole('listitem').filter({ has: this.electron.page.getByRole('button', { name: filename, exact: true }) });
    const file = row.getByRole('button', { name: filename, exact: true });
    await file.waitFor({ state: 'visible', timeout });
    // Completed rows omit status text; only a completed, existing file has both these enabled controls.
    await waitFor(() => file.isEnabled(), value => value, `IAB download ${filename} did not reach completed, present-file state`);
    await waitFor(() => file.getAttribute('title'), value => value === filename, `IAB download did not retain the exact filename ${filename}`);
    const folder = row.getByTitle(/^(在文件夹中显示|Show in folder)$/i);
    await folder.waitFor({ state: 'visible', timeout });
    await waitFor(() => folder.isEnabled(), value => value, `IAB completed download ${filename} has no enabled show-in-folder control`);
  }

  async clearSiteData(): Promise<void> {
    const main = this.electron.page;
    const dialogs = main.getByRole('dialog').or(main.getByRole('alertdialog'));
    if (await dialogs.count() !== 0) throw new Error('IAB site-data clearing requires no pre-existing application confirmation');
    const menu = await this.openMenu();
    await menu.getByRole('button', { name: /^(清除浏览数据|Clear browsing data)$/i }).click();
    const overlay = await this.overlay();
    const submenu = overlay.getByRole('dialog', { name: /^(清除浏览数据|Clear browsing data)$/i });
    await submenu.waitFor({ state: 'visible', timeout });
    await submenu.getByRole('button', { name: /^(清除共享\s*Cookie\s*和网站存储|Clear shared cookies and site storage)$/i }).click();
    await dialogs.waitFor({ state: 'visible', timeout });
    await dialogs.getByRole('button', { name: /^(清除|Clear)$/i }).click();
    const success = /已清除|清除成功|\bcleared\b/i;
    await waitFor(async () => [
      ...await main.getByRole('status').filter({ hasText: success, visible: true }).allTextContents(),
      ...await overlay.getByRole('status').filter({ hasText: success, visible: true }).allTextContents(),
    ], messages => messages.length > 0, 'IAB shared cookies and site storage clearing produced no success toast');
    await waitFor(() => dialogs.count(), value => value === 0, 'IAB site-data confirmation did not close after clearing');
  }
}
