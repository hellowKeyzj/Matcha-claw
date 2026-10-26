import type { Answerable } from '@serenity-js/core';
import { By, PageElement } from '@serenity-js/web';

const workspace = PageElement.located(By.css('main .world-workspace'));
const materials = workspace.element(By.role('tabpanel', { name: /^(Data sources|资料来源)$/, exact: true }));
const connections = materials.element(By.xpath('.//section[header//h2[normalize-space(.)="Business connections" or normalize-space(.)="业务连接"]]'));
const sourceDetails = materials.element(By.xpath('.//aside/section[header//h3[normalize-space(.)="Source details" or normalize-space(.)="来源详情"]]/div'));
const synchronization = sourceDetails.element(By.xpath('.//section[h4[normalize-space(.)="Source synchronization" or normalize-space(.)="数据源同步"]]'));
const discovery = sourceDetails.element(By.xpath('./section[h4[normalize-space(.)="Source schema" or normalize-space(.)="来源结构"]]'));
const data = workspace.element(By.role('tabpanel', { name: /^(Browse data|数据浏览)$/, exact: true }));
const objectDocument = workspace.element(By.css('article.world-object-document'));
const receipt = objectDocument.element(By.xpath('./details[summary[normalize-space(.)="Read receipt and coverage" or normalize-space(.)="读取回执与覆盖范围"]]'));
const confirmation = PageElement.located(By.css('[role="dialog"][aria-labelledby="confirm-dialog-title"]'));

export const WorldSourcesPage = {
  dataNavigation: PageElement.located(By.css('aside nav a[href="#/world"]')),
  materialsTab: workspace.element(By.role('tab', { name: /^(Data sources|资料来源)$/, exact: true })),
  dataTab: workspace.element(By.role('tab', { name: /^(Browse data|数据浏览)$/, exact: true })),
  materials,
  connections,
  connection: (name: Answerable<string>) => connections.element(By.cssContainingText('tbody tr td:first-child button', name)),
  connectionRecords: sourceDetails.elements(By.css(':scope > dl')),
  connectionRecord: sourceDetails.element(By.css(':scope > dl')),
  discovery,
  resource: discovery.element(By.role('textbox', { name: /^(Resource to discover|要发现的资源)$/, exact: true })),
  discover: discovery.element(By.role('button', { name: /^(Discover resource schema|发现资源结构)$/, exact: true })),
  synchronization,
  publishedBinding: synchronization.element(By.role('combobox', { name: /^(Published binding|已发布绑定)$/, exact: true })),
  readCheckpoint: synchronization.element(By.role('button', { name: /^(Read checkpoint|读取检查点)$/, exact: true })),
  start: synchronization.element(By.role('button', { name: /^(Request start|申请启动)$/, exact: true })),
  checkpointRecords: synchronization.elements(By.css(':scope > div > dl')),
  checkpointRecord: synchronization.element(By.css(':scope > div > dl')),
  confirmation,
  confirmations: PageElement.located(By.css('body')).elements(By.css('[role="dialog"][aria-labelledby="confirm-dialog-title"]')),
  confirm: confirmation.element(By.role('button', { name: /^(Confirm|确认)$/, exact: true })),
  cancel: confirmation.element(By.role('button', { name: /^(Cancel|取消)$/, exact: true })),
  operations: workspace.elements(By.role('region', { name: /^(Processing records|处理记录)$/, exact: true })),
  errors: workspace.elements(By.css('[role="alert"]')),
  queryType: workspace.element(By.css('form')).element(By.role('combobox', { name: /^(Object type|对象类型)$/, exact: true })),
  query: workspace.element(By.role('button', { name: /^(Query objects|查询对象)$/, exact: true })),
  data,
  object: (id: Answerable<string>) => workspace.element(By.cssContainingText('.world-object-main .world-table tbody tr td:first-child button', id)),
  selectedObjects: workspace.elements(By.css('article.world-object-document')),
  receiptSummary: receipt.element(By.css(':scope > summary')),
  receiptRecord: receipt.element(By.css(':scope > div > dl')),
  receiptRecords: receipt.elements(By.css(':scope > div > dl')),
  recordKeys: (root: 'connection' | 'checkpoint' | 'receipt', path: readonly (string | number)[]) => {
    const base = root === 'connection' ? sourceDetails.element(By.css(':scope > dl'))
      : root === 'checkpoint' ? synchronization.element(By.css(':scope > div > dl')) : receipt.element(By.css(':scope > div > dl'));
    const nested = path.map(part => typeof part === 'number' ? `/ol/li[${part + 1}]`
      : `/dl/div[dt[normalize-space(.)=${JSON.stringify(part)}]]/dd`).join('');
    return path.length ? base.elements(By.xpath(`.${nested.replace(/^\/dl/, '')}/dl/div/dt`)) : base.elements(By.css(':scope > div > dt'));
  },
  recordValue: (root: 'connection' | 'checkpoint' | 'receipt', path: readonly (string | number)[]) => {
    const base = root === 'connection' ? sourceDetails.element(By.css(':scope > dl'))
      : root === 'checkpoint' ? synchronization.element(By.css(':scope > div > dl')) : receipt.element(By.css(':scope > div > dl'));
    const nested = path.map(part => typeof part === 'number' ? `/ol/li[${part + 1}]`
      : `/dl/div[dt[normalize-space(.)=${JSON.stringify(part)}]]/dd`).join('');
    return path.length ? base.element(By.xpath(`.${nested.replace(/^\/dl/, '')}`)) : base;
  },
  recordItems: (root: 'connection' | 'checkpoint' | 'receipt', path: readonly (string | number)[]) => {
    const base = root === 'connection' ? sourceDetails.element(By.css(':scope > dl'))
      : root === 'checkpoint' ? synchronization.element(By.css(':scope > div > dl')) : receipt.element(By.css(':scope > div > dl'));
    const nested = path.map(part => typeof part === 'number' ? `/ol/li[${part + 1}]`
      : `/dl/div[dt[normalize-space(.)=${JSON.stringify(part)}]]/dd`).join('');
    return base.elements(By.xpath(`.${nested.replace(/^\/dl/, '')}/ol/li`));
  },
};
