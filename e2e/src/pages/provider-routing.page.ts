import { By, PageElement } from '@serenity-js/web';

const main = PageElement.located(By.css('main'));
const toggle = main.element(By.role('button', { name: /^(模型分配|Default Models)$/ }));
const panel = toggle.element(By.xpath('ancestor::div[3]'));

export const ProviderRoutingPage = {
  navigation: PageElement.located(By.css('aside a[href="#/providers"]')),
  toggle,
  refresh: panel.element(By.role('button', { name: /^(刷新|Refresh)$/ })),
  primary: (capability: string) => panel.element(By.id(`capability-${capability}-primary`)),
};
