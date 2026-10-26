import { By, PageElement } from '@serenity-js/web';
import { WorldWorkspacePage } from './world-workspace.page.js';

const resolution = WorldWorkspacePage.resolution;
const dialog = PageElement.located(By.role('dialog'));
const records = PageElement.located(By.css('main .world-workspace')).element(By.role('region', { name: /^(Processing records|处理记录)$/, exact: true }));

export const WorldViewsPage = {
  resolution,
  summary: WorldWorkspacePage.resolutionSummary,
  versionTab: WorldWorkspacePage.versionTab,
  taskScope: WorldWorkspacePage.taskScope,
  taskRefresh: WorldWorkspacePage.taskRefresh,
  task: WorldWorkspacePage.resolutionTask,
  reading: resolution.elements(By.css('[role="status"]')),
  errors: resolution.elements(By.css('[role="alert"]')),
  contracts: WorldWorkspacePage.fullContracts,
  abstraction: resolution.element(By.role('combobox', { name: /^(Exact abstraction revision|精确抽象修订)$/, exact: true })),
  inspect: resolution.element(By.role('button', { name: /^(Read exact abstraction|读取精确抽象)$/, exact: true })),
  queryType: resolution.element(By.role('combobox', { name: /^(Readable exact object or relation type|可读取的精确对象或关系类型)$/, exact: true })),
  buildView: resolution.element(By.role('button', { name: /^(Build authorized task view|构建获准任务视图)$/, exact: true })),
  views: resolution.elements(By.role('heading', { level: 4, name: 'WorldView', exact: true })),
  test: resolution.element(By.role('combobox', { name: /^(Independent recorded test revision|独立已登记测试修订)$/, exact: true })),
  readEndpoints: resolution.element(By.role('button', { name: /^(Read available native runtimes|读取可用原生运行时)$/, exact: true })),
  endpoint: resolution.element(By.role('combobox', { name: /^(Local runtime|本地运行时)$/, exact: true })),
  readSessions: resolution.element(By.role('button', { name: /^(Read existing sessions|读取已有会话)$/, exact: true })),
  session: resolution.element(By.role('combobox', { name: /^(Existing native session|已有原生会话)$/, exact: true })),
  submit: WorldWorkspacePage.resolve,
  dialogs: PageElement.located(By.css('body')).elements(By.role('dialog')),
  confirm: dialog.element(By.role('button', { name: /^(Confirm|确认)$/, exact: true })),
  records,
  operationSession: records.element(By.role('combobox', { name: /^(Records from this session|本次会话记录)$/, exact: true })),
  recordRegions: PageElement.located(By.css('main .world-workspace')).elements(By.role('region', { name: /^(Processing records|处理记录)$/, exact: true })),
  operationPhases: records.elements(By.css('aside .world-status[data-status]')),
  operationPhase: records.element(By.css('aside .world-status[data-status]')),
};
