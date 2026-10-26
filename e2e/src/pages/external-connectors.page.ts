import type { Answerable } from '@serenity-js/core';
import { By, PageElement, PageElements } from '@serenity-js/web';

const dialog = PageElement.located(By.role('dialog', { name: '新增连接器', exact: true }));
const card = (name: Answerable<string>) => PageElement.located(By.css('article')).closestTo(
  PageElement.located(By.role('heading', { level: 3, name, exact: true })),
);

export const ExternalConnectorsPage = {
  agentNavigation: PageElement.located(By.css('aside nav a[href="#/subagents"]')),
  connectorNavigation: PageElement.located(By.css('main header nav a[href^="#/connectors"]')),
  selectedRuntime: PageElement.located(By.css('main header [role="radiogroup"] [role="radio"][aria-checked="true"], main header [role="img"][aria-label]')),
  runtime: (name: Answerable<string>) => PageElement.located(By.css('main header')).element(By.role('radio', { name, exact: true })),
  onlyRuntime: (name: Answerable<string>) => PageElement.located(By.css('main header')).element(By.role('img', { name, exact: true })),
  readyCount: PageElement.located(By.xpath('//main//h2[contains(normalize-space(.), "我的连接器")]/div')),
  errors: PageElements.located(By.css('main p[role="alert"]')),
  heading: PageElement.located(By.role('heading', { level: 1, name: /^(连接器|Connectors)$/ })),
  add: PageElements.located(By.role('button', { name: '新增连接器', exact: true })).first(),
  dialog,
  id: dialog.element(By.css('#connector-id')),
  kind: dialog.element(By.css('#connector-kind')),
  name: dialog.element(By.css('#connector-name')),
  baseUrl: dialog.element(By.css('#connector-base-url')),
  headers: dialog.element(By.css('#connector-headers')),
  create: dialog.element(By.role('button', { name: '创建连接器', exact: true })),
  cancel: dialog.element(By.role('button', { name: '取消', exact: true })),
  rejection: dialog.element(By.xpath('.//p[normalize-space(.)="External connector request is invalid"]')),
  search: PageElement.located(By.role('textbox', { name: '搜索连接器', exact: true })),
  kindFilter: PageElement.located(By.role('combobox', { name: '协议类型', exact: true })),
  statusFilter: PageElement.located(By.role('combobox', { name: '启用状态', exact: true })),
  card,
  idForName: (name: Answerable<string>) => card(name).element(By.css('p[title]')),
  nameForName: (name: Answerable<string>) => card(name).element(By.role('heading', { level: 3 })),
  enabled: (name: Answerable<string>) => card(name).element(By.xpath('.//span[normalize-space(.)="已启用"]')),
  unsupported: (name: Answerable<string>) => card(name).element(By.xpath('.//span[normalize-space(.)="待会话验证"]')),
  probe: (name: Answerable<string>) => card(name).element(By.css('button[aria-label^="检测 "]')),
  remove: (name: Answerable<string>) => card(name).element(By.css('button[aria-label^="删除 "]')),
};
