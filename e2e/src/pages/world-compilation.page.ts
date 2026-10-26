import { By, PageElement } from '@serenity-js/web';
import { WorldAuthoringPage } from './world-authoring.page.js';

const workspace = PageElement.located(By.css('main .world-workspace'));
const version = workspace.element(By.role('tabpanel', { name: /^(Version & compile baseline|版本与编译基线)$/, exact: true }));
const taskRecord = version.element(By.xpath('.//details[summary[normalize-space(.)="Contract details" or normalize-space(.)="契约详情"]]/div'));
const changeRecord = workspace.element(By.css('article.world-panel > .world-panel-body > details > div'));
const recordPath = (path: readonly (string | number)[]) => path.map(part => typeof part === 'number'
  ? `/ol/li[${part + 1}]` : `/dl/div[dt[normalize-space(.)=${JSON.stringify(part)}]]/dd`).join('');

export const WorldCompilationPage = {
  modelNavigation: PageElement.located(By.css('aside nav a[href="#/world/model"]')),
  settingsNavigation: PageElement.located(By.css('aside nav a[href="#/world/settings"]')),
  registerTask: version.element(By.role('button', { name: /^(Register task|登记任务)$/, exact: true })),
  registrationNotices: version.elements(By.xpath('.//p[@role="status" and (contains(., "Task contract submitted") or contains(., "任务契约已提交"))]')),
  operationRecords: workspace.elements(By.role('region', { name: /^(Processing records|处理记录)$/, exact: true })),
  operationSession: workspace.element(By.role('combobox', { name: /^(Records from this session|本次会话记录)$/, exact: true })),
  operationPhases: workspace.elements(By.css('aside[aria-labelledby="world-operation-trace"] .world-status[data-status]')),
  operationPhase: workspace.element(By.css('aside[aria-labelledby="world-operation-trace"] .world-status[data-status]')),
  orderTaskOptions: WorldAuthoringPage.task.elements(By.xpath('./option[contains(., " · task:order-line-total:20261026:r1 · 1")]')),
  versionTab: workspace.element(By.role('tab', { name: /^(Version & compile baseline|版本与编译基线)$/, exact: true })),
  versionPanels: workspace.elements(By.role('tabpanel', { name: /^(Version & compile baseline|版本与编译基线)$/, exact: true })),
  canvasTabs: workspace.elements(By.role('tab', { name: /^(Relation canvas|关系画布)$/, exact: true })),
  taskImport: version.element(By.xpath('.//details/summary[normalize-space(.)="Import a complete task contract" or normalize-space(.)="导入完整任务契约"]')),
  importedTasks: version.elements(By.xpath('.//details[summary[normalize-space(.)="Contract details" or normalize-space(.)="契约详情"]]')),
  cancelTaskImport: version.element(By.role('button', { name: /^(Cancel contract import|取消契约导入)$/, exact: true })),
  taskValue: (path: readonly (string | number)[]) => taskRecord.element(By.xpath(`.${recordPath(path)}`)),
  taskKeys: (path: readonly (string | number)[]) => taskRecord.elements(By.xpath(`.${recordPath(path)}/dl/div/dt`)),
  taskItems: (path: readonly (string | number)[]) => taskRecord.elements(By.xpath(`.${recordPath(path)}/ol/li`)),
  noOpTaskOptions: WorldAuthoringPage.task.elements(By.xpath('./option[contains(., " · manual-noop-prefix-20261025-81b7c54e · 1")]')),
  orderFunctionOptions: WorldAuthoringPage.functionDefinition.elements(By.css('option[value="function:order-line-total:20261026:r1:1"]')),
  compilationGroups: workspace.elements(By.role('group', { name: /^(Target and external uses for this compilation|本次编译的目标与外部用途)$/, exact: true })),
  orderChangeCandidates: workspace.elements(By.cssContainingText('.world-catalog li > button', 'function:order-line-total:20261026:r1')),
  changeId: workspace.element(By.css('article.world-panel > header > div > span.font-mono')),
  changeIdentity: workspace.element(By.xpath('.//article[contains(@class,"world-panel")]/div/details/summary[normalize-space(.)="Change identity and revision information" or normalize-space(.)="变更标识与版本信息"]')),
  changeValue: (path: readonly (string | number)[]) => changeRecord.element(By.xpath(`.${recordPath(path)}`)),
  closeChange: workspace.element(By.css('article.world-panel')).element(By.role('button', { name: /^(Close details|关闭详情)$/, exact: true })),
  selectedChanges: workspace.elements(By.css('.world-catalog li > button[aria-pressed="true"]')),
};
