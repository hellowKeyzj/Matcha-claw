import { By, PageElement } from '@serenity-js/web';

const workspace = PageElement.located(By.css('main .world-workspace'));
const actions = workspace.element(By.role('tabpanel', { name: /^(Business actions|业务操作)$/, exact: true }));
const identity = actions.element(By.xpath('.//aside[contains(@class,"world-detail-panel")]//div[h4[normalize-space(.)="Request and idempotency identity" or normalize-space(.)="请求与幂等标识"]]/details/div'));
const recordPath = (path: readonly (string | number)[]) => path.map(part => typeof part === 'number'
  ? `/ol/li[${part + 1}]` : `/dl/div[dt[normalize-space(.)=${JSON.stringify(part)}]]/dd`).join('');

export const WorldActionsPage = {
  actions,
  createProposal: actions.element(By.role('button', { name: /^(Create proposal|生成提案)$/, exact: true })),
  approve: actions.element(By.role('button', { name: /^(Approve as current identity|按当前身份审批)$/, exact: true })),
  submit: actions.element(By.role('button', { name: /^(Submit proposal|提交提案)$/, exact: true })),
  collapse: actions.element(By.css('main.world-panel > header')).element(By.role('button', { name: /^(Collapse|收起)$/, exact: true })),
  errors: workspace.elements(By.css('[role="alert"]')),
  selectedProposals: actions.elements(By.css('aside.world-catalog section:first-child li button[aria-pressed="true"]')),
  selectedProposalId: actions.element(By.css('aside.world-catalog section:first-child li button[aria-pressed="true"] > span:last-child')),
  submissionIds: actions.elements(By.css('main.world-panel section button.break-all')),
  identityValue: (path: readonly (string | number)[]) => identity.element(By.xpath(`.${recordPath(path)}`)),
  identityKeys: (path: readonly (string | number)[]) => identity.elements(By.xpath(`.${recordPath(path)}/dl/div/dt`)),
  identityItems: (path: readonly (string | number)[]) => identity.elements(By.xpath(`.${recordPath(path)}/ol/li`)),
};
