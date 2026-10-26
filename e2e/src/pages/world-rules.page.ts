import { By } from '@serenity-js/web';
import { WorldWorkspacePage } from './world-workspace.page.js';

const workspace = WorldWorkspacePage.workspace;
const evaluation = workspace.element(By.role('region', { name: /^(Evaluate rule|执行规则)$/, exact: true }));
const preview = evaluation.element(By.xpath('.//details[summary[normalize-space(.)="Exact evaluation input" or normalize-space(.)="精确求值输入"]]/div'));
const result = workspace.element(By.role('region', { name: /^(Confirmed result|已确认结果)$/, exact: true }));
const resultRecord = result.element(By.xpath('.//details[summary[normalize-space(.)="Result details" or normalize-space(.)="结果详情"]]/div'));
const recordPath = (path: readonly (string | number)[]) => path.map(part => typeof part === 'number'
  ? `/ol/li[${part + 1}]` : `/dl/div[dt[normalize-space(.)=${JSON.stringify(part)}]]/dd`).join('');

export const WorldRulesPage = {
  modelNavigation: WorldWorkspacePage.modelNavigation,
  candidateTab: workspace.element(By.role('tab', { name: /^(Candidate rules|候选规则)$/, exact: true })),
  candidate: workspace.element(By.role('combobox', { name: /^(Candidate rules|候选规则)$/, exact: true })),
  definitionTab: workspace.element(By.role('tab', { name: /^(Definition|定义)$/, exact: true })),
  catalogRule: (id: string, revision: string) => workspace.element(By.xpath(`.//nav[@aria-label]/section/button[contains(@title, ${JSON.stringify(` · ${id} / ${revision}`)})]`)),
  openEvaluation: workspace.element(By.css('[role="tabpanel"] header')).element(By.role('button', { name: /^(Evaluate rule|执行规则)$/, exact: true })),
  evaluation,
  target: evaluation.element(By.role('combobox', { name: /^(Evaluation target|求值位置)$/, exact: true })),
  loadObjects: evaluation.element(By.role('button', { name: /^(Load parameter objects|读取参数对象)$/, exact: true })),
  previewSummary: evaluation.element(By.xpath('.//details/summary[normalize-space(.)="Exact evaluation input" or normalize-space(.)="精确求值输入"]')),
  execute: evaluation.element(By.css('form > button[type="submit"], form > button:not([type])')),
  errors: WorldWorkspacePage.errors,
  historySummary: WorldWorkspacePage.historySummary,
  operationId: WorldWorkspacePage.operationId,
  lookup: WorldWorkspacePage.lookup,
  phase: WorldWorkspacePage.tracePhase,
  phases: WorldWorkspacePage.tracePhases,
  resultSummary: result.element(By.xpath('.//details/summary[normalize-space(.)="Result details" or normalize-space(.)="结果详情"]')),
  previewValue: (path: readonly (string | number)[]) => preview.element(By.xpath(`.${recordPath(path)}`)),
  previewKeys: (path: readonly (string | number)[]) => preview.elements(By.xpath(`.${recordPath(path)}/dl/div/dt`)),
  previewItems: (path: readonly (string | number)[]) => preview.elements(By.xpath(`.${recordPath(path)}/ol/li`)),
  resultValue: (path: readonly (string | number)[]) => resultRecord.element(By.xpath(`.${recordPath(path)}`)),
  resultKeys: (path: readonly (string | number)[]) => resultRecord.elements(By.xpath(`.${recordPath(path)}/dl/div/dt`)),
  resultItems: (path: readonly (string | number)[]) => resultRecord.elements(By.xpath(`.${recordPath(path)}/ol/li`)),
};
