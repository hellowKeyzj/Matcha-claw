import { By, PageElement } from '@serenity-js/web';

export const LicensePage = {
  openSettings: PageElement.located(By.css('button[title="Settings"], button[title="设置"]')).describedAs('open settings'),
  license: PageElement.located(By.role('navigation', { name: /^(Settings|设置)$/ }))
    .element(By.role('button', { name: 'Lisence', exact: true })).describedAs('license settings navigation'),
  generalHeading: PageElement.located(By.role('heading', { level: 3, name: /^(General|通用)$/ })).describedAs('general settings heading'),
  settings: PageElement.located(By.css('[data-testid="settings-page"]')).describedAs('settings page'),
  heading: PageElement.located(By.role('heading', { level: 3, name: 'Lisence', exact: true })).describedAs('license settings heading'),
  status: PageElement.located(By.role('heading', { level: 3, name: 'Lisence', exact: true }))
    .element(By.xpath('following-sibling::*[@role="status"]')).describedAs('license gate status'),
  key: PageElement.located(By.id('settings-license-key')).describedAs('license key input'),
  activate: PageElement.located(By.role('button', { name: /^(Activate|激活)$/ })).describedAs('activate license'),
  showKey: PageElement.located(By.role('button', { name: /^(Show license key|显示授权码)$/ })).describedAs('show license key'),
  hideKey: PageElement.located(By.role('button', { name: /^(Hide license key|隐藏授权码)$/ })).describedAs('hide license key'),
  error: PageElement.located(By.id('settings-license-error')).describedAs('license validation error'),
  general: PageElement.located(By.role('navigation', { name: /^(Settings|设置)$/ }))
    .element(By.role('button', { name: /^(General|通用)$/ })).describedAs('general settings navigation'),
};
