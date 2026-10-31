import { By, PageElement } from '@serenity-js/web';

const workspace = PageElement.located(By.css('main .world-workspace'));
const backup = workspace.element(By.css('details.group\\/backup'));
const records = workspace.element(By.role('region', { name: /^(Processing records|处理记录)$/, exact: true }));
const timeline = records.element(By.css('section[aria-labelledby="world-operation-timeline"]'));
const result = records.element(By.role('region', { name: /^(Result and receipts|结果与回执)$/, exact: true }));
const resultDetails = result.element(By.xpath('.//details[summary[normalize-space(.)="Result details" or normalize-space(.)="结果详情"]]'));
const identity = result.element(By.xpath('.//details[summary[normalize-space(.)="Receipt identity" or normalize-space(.)="回执归属"]]'));
const recordPath = (path: readonly string[]) => path.map(key => `/dl/div[dt[normalize-space(.)=${JSON.stringify(key)}]]/dd`).join('');

export const WorldArchivePage = {
  settings: PageElement.located(By.css('aside nav a[href="#/world/settings"]')),
  storageTab: workspace.element(By.role('tab', { name: /^(Storage and setup|存储与初始化)$/, exact: true })),
  operationsTab: workspace.element(By.role('tab', { name: /^(Processing records|处理记录)$/, exact: true })),
  backupSummary: backup.element(By.css('summary')),
  backupRows: backup.elements(By.css('tbody tr')),
  backupValues: backup.elements(By.css('tbody tr td:last-child')),
  includeMaterials: backup.element(By.role('checkbox', { name: /^(Include all material history|包含全部材料历史)$/, exact: true })),
  createBackup: backup.element(By.role('button', { name: /^(Create backup|创建备份)$/, exact: true })),
  operationSelect: records.element(By.css('aside[aria-labelledby="world-operation-records"] select')),
  phase: timeline.element(By.css('header .world-status[data-status]')),
  phases: timeline.elements(By.css('header .world-status[data-status]')),
  operationId: timeline.element(By.css('header p.font-mono')),
  finalReceipt: timeline.element(By.role('button', { name: /^(Check final receipt|核对最终回执)$/, exact: true })),
  resultSummary: resultDetails.element(By.css('summary')),
  resultOpen: resultDetails.element(By.xpath('./div/dl')),
  resultValue: (path: readonly string[]) => resultDetails.element(By.xpath(`./div${recordPath(path)}`)),
  identitySummary: identity.element(By.css('summary')),
  identityOpen: identity.element(By.xpath('./div/dl')),
  identityValue: (path: readonly string[]) => identity.element(By.xpath(`./div${recordPath(path)}`)),
  download: result.element(By.role('button', { name: /^(Save backup operation receipt|保存备份操作回执)$/, exact: true })),
  readback: result.element(By.role('button', { name: /^(Check the current world|核对当前世界)$/, exact: true })),
  resultStatuses: result.elements(By.css('p[role="status"]')),
  errors: workspace.elements(By.css('[role="alert"]')),
  pendingRequests: workspace.elements(By.role('button', { name: /^(Check original request|核对原请求)$/, exact: true })),
};
