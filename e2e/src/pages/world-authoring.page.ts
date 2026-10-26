import type { Answerable } from '@serenity-js/core';
import { By, PageElement, PageElements } from '@serenity-js/web';

const workspace = PageElement.located(By.css('main .world-workspace'));
const authoring = workspace.element(By.role('tabpanel', { name: /^(Author definitions|手工建模)$/, exact: true }));
const scope = authoring.element(By.role('combobox', { name: /^(Business scope|业务范围)$/, exact: true }));
const task = authoring.element(By.role('combobox', { name: /^(Related task|关联任务)$/, exact: true }));
const compilation = authoring.element(By.role('group', { name: /^(Target and external uses for this compilation|本次编译的目标与外部用途)$/, exact: true }));
const targetLock = compilation.element(By.role('combobox', { name: /^(Exact target binding lock|精确目标绑定锁)$/, exact: true }));
const functionDefinition = compilation.element(By.role('combobox', { name: /^(Actual function definition and revision|真实函数定义与修订)$/, exact: true }));

export const WorldAuthoringPage = {
  navigationGroup: PageElement.located(By.css('aside nav button[aria-controls="sidebar-world-pages"]')),
  modelNavigation: PageElement.located(By.css('aside nav a[href="#/world/model"]')),
  changesNavigation: PageElement.located(By.css('aside nav a[href="#/world/changes"]')),
  heading: workspace.element(By.role('heading', { level: 1, name: /^(Models & rules|模型与规则)$/, exact: true })),
  worldSelector: workspace.element(By.role('button', { name: /^(Switch world|Open an existing world|切换世界|打开已有世界)$/, exact: true })),
  tenant: workspace.element(By.role('textbox', { name: /^(Tenant ID|租户编号)$/, exact: true })),
  world: workspace.element(By.role('textbox', { name: /^(World ID|世界编号)$/, exact: true })),
  open: workspace.element(By.role('button', { name: /^(Open world|打开世界)$/, exact: true })),
  statuses: workspace.elements(By.css('.world-heading [data-status]')),
  status: workspace.element(By.css('.world-heading [data-status]')),
  errors: workspace.elements(By.css('[role="alert"]')),
  authoringTab: workspace.element(By.role('tab', { name: /^(Author definitions|手工建模)$/, exact: true })),
  canvasTab: workspace.element(By.role('tab', { name: /^(Relation canvas|关系画布)$/, exact: true })),
  authoringPanels: workspace.elements(By.role('tabpanel', { name: /^(Author definitions|手工建模)$/, exact: true })),
  file: authoring.element(By.css('input[type="file"]')).describedAs('manual definition JSON file input'),
  files: workspace.elements(By.css('input[type="file"]')),
  scope,
  scopeOptions: scope.elements(By.css('option[value]:not([value=""]):not(:disabled)')),
  task,
  taskOptions: task.elements(By.css('option[value]:not([value=""]):not(:disabled)')),
  noTasks: authoring.element(By.xpath('.//p[normalize-space(.)="No related tasks in this scope. Register a task first." or normalize-space(.)="此范围暂无可关联任务，请先登记任务。"]')),
  previews: authoring.elements(By.css('pre[aria-label]')),
  preview: authoring.element(By.css('pre[aria-label]')),
  previewSummary: authoring.element(By.css('details:has(pre[aria-label]) > summary')),
  remove: authoring.element(By.role('button', { name: /^(Remove definition file|移除定义文件)$/, exact: true })),
  submit: authoring.element(By.role('button', { name: /^(Submit for review|送交审核)$/, exact: true })),
  noOpReason: authoring.element(By.role('textbox', { name: /^(Reason for no model change \(optional\)|无模型改动的理由（可选）)$/, exact: true })),
  changesHeadings: workspace.elements(By.role('heading', { level: 1, name: /^(Evolution review|变更审核)$/, exact: true })),
  ownChange: (reason: Answerable<string>) => workspace.element(By.cssContainingText('.world-catalog li > button', reason)),
  ownValidatedChange: (reason: Answerable<string>) => workspace.element(By.cssContainingText('.world-catalog li > button', reason))
    .element(By.xpath('./span/span[normalize-space(.)="已验证" or normalize-space(.)="Validated"]')),
  changeId: workspace.element(By.css('article.world-panel > header > div > span.font-mono')),
  validate: workspace.element(By.role('button', { name: /^(Validate this revision|验证此修订)$/, exact: true })),
  refresh: workspace.element(By.css('.world-heading')).element(By.role('button', { name: /^(Refresh|刷新)$/, exact: true })),
  validated: workspace.element(By.css('article.world-panel > header')).elements(By.xpath('./div/span[normalize-space(.)="已验证" or normalize-space(.)="Validated"]')),
  compilation,
  targetLock,
  baselineLocks: targetLock.elements(By.xpath('./option[contains(., "Current version baseline") or contains(., "当前版本基线")]')),
  baselineLock: targetLock.element(By.xpath('./option[contains(., "Current version baseline") or contains(., "当前版本基线")]')),
  externalUses: compilation.elements(By.css('table tbody tr')),
  addUse: compilation.element(By.css('details > summary')),
  use: compilation.element(By.role('combobox', { name: /^(Actual use|实际用途)$/, exact: true })),
  functionDefinition,
  functionOption: (batch: 'first' | 'replacement') => functionDefinition.elements(By.css(`option[value="function:e2e-authoring:${batch}:1"]`)),
  confirm: compilation.element(By.role('button', { name: /^(Confirm compilation selection|确认本次编译选择)$/, exact: true })),
  confirmations: compilation.elements(By.role('button', { name: /^(Compilation selection confirmed|已确认本次编译选择)$/, exact: true })),
  pendingConfirmations: compilation.elements(By.role('button', { name: /^(Confirm compilation selection|确认本次编译选择)$/, exact: true })),
  remainingPreviews: PageElements.located(By.css('main .world-workspace pre[aria-label]')),
};
