import type { Answerable } from '@serenity-js/core';
import { By, PageElement, PageElements } from '@serenity-js/web';

const main = PageElement.located(By.css('main'));
const grid = main.element(By.css('[data-testid="subagent-card-grid"]'));
const createDialog = PageElement.located(By.role('dialog', { name: /^(新增Agent|Create Subagent)$/i }));
const deleteDialog = PageElement.located(By.role('dialog', { name: /^(删除 |Delete )/i }));
const cardNamed = (name: Answerable<string>) => PageElement.located(By.css('article')).closestTo(
  grid.element(By.role('heading', { level: 2, name, exact: true })),
);

export const AgentPage = {
  navigation: PageElement.located(By.css('aside nav')).element(By.role('link', { name: /^(Subagents|Agent)$/i })),
  openClawRuntime: main.element(By.role('radio', { name: 'OpenClaw', exact: true })),
  onlyOpenClawRuntime: main.element(By.role('img', { name: 'OpenClaw', exact: true })),
  myAgentsTab: main.element(By.role('tab', { name: /^(我的 Agent|My Agents)(?:\s*\d+)?$/i })),
  search: main.element(By.role('searchbox', { name: /^(搜索 Agent\.\.\.|Search agents\.\.\.)$/i })),
  grid,
  ids: grid.elements(By.xpath('.//article//h2[@title]/parent::div/following-sibling::p[@title]')),
  newAgent: main.element(By.role('button', { name: /^(新增 Agent|New Agent)$/i })),
  cardNamed,
  nameForName: (name: Answerable<string>) => cardNamed(name).element(By.role('heading', { level: 2 })),
  card: (selector: Answerable<string>) => grid.element(By.css(selector)),
  namedCards: (name: Answerable<string>) => grid.elements(By.role('heading', { level: 2, name, exact: true })),
  idForName: (name: Answerable<string>) => cardNamed(name).element(By.xpath('.//h2[@title]/parent::div/following-sibling::p[@title]')),
  moreForName: (name: Answerable<string>) => cardNamed(name).element(By.role('button', { name: /^(更多操作|More actions) /i })),
  chatForName: (name: Answerable<string>) => cardNamed(name).element(By.role('button', { name: /^(会话|Chat) /i })),
  cardName: (selector: Answerable<string>) => grid.element(By.css(selector)).element(By.role('heading', { level: 2 })),
  more: (selector: Answerable<string>) => grid.element(By.css(selector)).element(By.role('button', { name: /^(更多操作|More actions) /i })),
  chat: (selector: Answerable<string>) => grid.element(By.css(selector)).element(By.role('button', { name: /^(会话|Chat) /i })),
  createDialog,
  createDialogs: PageElements.located(By.role('dialog', { name: /^(新增Agent|Create Subagent)$/i })),
  name: createDialog.element(By.css('#subagent-name')),
  model: createDialog.element(By.css('#subagent-model')),
  availableModels: createDialog.elements(By.css('#subagent-model option:not([value=""]):not(:disabled)')),
  create: createDialog.element(By.role('button', { name: /^(创建|Create)$/i })),
  closeCreate: createDialog.element(By.role('button', { name: /^(取消|Cancel)$/i })),
  deleteMenuItem: PageElement.located(By.role('menuitem', { name: /^(删除|Delete)$/i })),
  deleteDialog,
  deleteDialogs: PageElements.located(By.role('dialog', { name: /^(删除 |Delete )/i })),
  delete: deleteDialog.element(By.role('button', { name: /^(确认删除|Delete)$/i })),
  closeDelete: deleteDialog.element(By.role('button', { name: /^(关闭|Close)$/i })),
};
