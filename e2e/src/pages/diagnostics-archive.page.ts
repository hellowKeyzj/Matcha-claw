import { By, PageElement } from '@serenity-js/web';
import { LicensePage } from './license.page.js';

export const DiagnosticsArchivePage = {
  openSettings: LicensePage.openSettings,
  settings: LicensePage.settings,
  navigation: PageElement.located(By.role('navigation', { name: /^(Settings|设置)$/ }))
    .element(By.role('button', { name: /^(Diagnostics|诊断导出)$/, exact: true })).describedAs('diagnostics settings navigation'),
  heading: PageElement.located(By.role('heading', { level: 3, name: /^(Diagnostics|诊断导出)$/ })).describedAs('diagnostics settings heading'),
  export: PageElement.located(By.role('button', { name: /^(Export Bundle|导出诊断包)$/, exact: true })).describedAs('export diagnostics archive'),
  archiveId: PageElement.located(By.css('[data-testid="settings-page"] input[readonly]')).describedAs('opaque saved archive identity'),
  metadata: PageElement.located(By.xpath('//*[@data-testid="settings-page"]//input[@readonly]/following-sibling::p')).describedAs('saved archive entry and byte counts'),
  saved: PageElement.located(By.xpath(
    '//li[@data-sonner-toast and @data-type="success"]//div[@data-title and (starts-with(normalize-space(.), "Diagnostics archive exported, entries:") or starts-with(normalize-space(.), "诊断归档已导出，条目数："))]',
  )).describedAs('real diagnostics archive saved confirmation'),
  body: PageElement.located(By.css('body')).describedAs('public diagnostics page text'),
};
