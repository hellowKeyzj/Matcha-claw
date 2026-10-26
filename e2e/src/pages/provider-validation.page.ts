import type { Answerable } from '@serenity-js/core';
import { By, PageElement } from '@serenity-js/web';

const main = PageElement.located(By.css('main'));
const dialog = PageElement.located(By.role('dialog', { name: /^(添加 AI 提供商|Add AI Provider)$/ }));
const providerToggle = main.element(By.role('button', { name: /^(模型|Models)$/ }));
const providers = providerToggle.element(By.xpath('ancestor::div[3]'));
const header = (label: Answerable<string>) => providers.element(By.role('button', { name: label }));
const card = (label: Answerable<string>) => header(label).element(By.xpath('ancestor::div[3]'));
const models = (label: Answerable<string>) => card(label)
  .element(By.role('button', { name: /^(模型清单|Model catalog)$/ }))
  .element(By.xpath('ancestor::section[1]'));

export const ProviderValidationPage = {
  navigation: PageElement.located(By.css('aside a[href="#/providers"]')),
  heading: main.element(By.role('heading', { name: /^(模型|Models)$/, level: 1 })),
  providerToggle,
  add: providers.element(By.role('button', { name: /^(添加提供商|Add Provider)$/ })),
  refresh: providers.element(By.role('button', { name: /^(刷新|Refresh)$/ })),
  dialog,
  custom: dialog.element(By.role('button', { name: /(自定义|Custom)$/ })),
  ollama: dialog.element(By.role('button', { name: /Ollama$/ })),
  name: dialog.element(By.id('name')),
  apiKey: dialog.element(By.id('apiKey')),
  apiKeys: dialog.elements(By.id('apiKey')),
  apiKeyLabels: dialog.elements(By.css('label[for="apiKey"]')),
  baseUrl: dialog.element(By.id('baseUrl')),
  protocol: dialog.element(By.id('provider-add-protocol')),
  chatProvider: dialog.element(By.role('button', { name: /^(聊天提供商|Chat provider)$/ })),
  submit: dialog.element(By.role('button', { name: /^(添加提供商|Add Provider)$/ })),
  cancel: dialog.element(By.css('header')).element(By.role('button', { name: /^(取消|Cancel)$/ })),
  invalidKey: dialog.element(By.xpath('.//p[normalize-space(.)="无效的 API 密钥" or normalize-space(.)="Invalid API key"]')),
  addFailure: PageElement.located(By.xpath('//li[@data-sonner-toast and @data-type="error"]//div[@data-title and (starts-with(normalize-space(.), "添加提供商失败") or starts-with(normalize-space(.), "Failed to add provider"))]')),
  body: PageElement.located(By.css('body')),
  header,
  delete: (label: Answerable<string>) => card(label).element(By.css('button[title="删除提供商"], button[title="Delete provider"]')),
  addModel: (label: Answerable<string>) => models(label).element(By.role('button', { name: /^(添加模型|Add model)$/ })),
  modelInputs: (label: Answerable<string>) => models(label).elements(By.role('textbox', { name: /^(模型 ID|Model ID)$/ })),
  saveModels: (label: Answerable<string>) => models(label).element(By.role('button', { name: /^(保存更改|Save changes)$/ })),
  discardModels: (label: Answerable<string>) => models(label).element(By.role('button', { name: /^(撤销|Discard)$/ })),
  modelError: (label: Answerable<string>) => models(label).element(By.css('p.text-destructive')),
};
