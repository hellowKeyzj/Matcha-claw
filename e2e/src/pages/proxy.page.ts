import { By, PageElement } from '@serenity-js/web';
import { LicensePage } from './license.page.js';

export const ProxyPage = {
  openSettings: LicensePage.openSettings,
  settings: LicensePage.settings,
  runtimeStatus: PageElement.located(By.role('navigation', { name: /^(Settings|设置)$/ }))
    .element(By.role('button', { name: /^(Runtime Status|运行状态)$/, exact: true })).describedAs('runtime status settings navigation'),
  expand: PageElement.located(By.css('[data-testid="settings-proxy-expand"]')).describedAs('expand proxy settings'),
  section: PageElement.located(By.css('[data-testid="settings-proxy-section"]')).describedAs('proxy settings section'),
  toggle: PageElement.located(By.css('[data-testid="settings-proxy-toggle"]')).describedAs('proxy switch'),
  server: PageElement.located(By.role('textbox', { name: /^(Proxy Server|代理服务器)$/, exact: true })).describedAs('proxy server'),
  bypass: PageElement.located(By.css('#proxy-bypass')).describedAs('proxy bypass rules'),
  save: PageElement.located(By.css('[data-testid="settings-proxy-save-button"]')).describedAs('save proxy settings'),
  saved: PageElement.located(By.xpath(
    '//li[@data-sonner-toast and @data-type="success"]//div[@data-title and (normalize-space(.)="代理设置已保存" or normalize-space(.)="Proxy settings saved")]',
  )).describedAs('proxy settings saved confirmation'),
};
