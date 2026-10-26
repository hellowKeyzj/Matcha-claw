import { By, PageElement, PageElements } from '@serenity-js/web';

const workspace = PageElement.located(By.css('main .world-workspace'));
const panels = workspace.elements(By.xpath('.//section[contains(concat(" ", normalize-space(@class), " "), " world-panel ")][header//h2[normalize-space(.)="独立评测身份" or normalize-space(.)="Independent evaluation identities"]]'));
const panel = workspace.element(By.xpath('.//section[contains(concat(" ", normalize-space(@class), " "), " world-panel ")][header//h2[normalize-space(.)="独立评测身份" or normalize-space(.)="Independent evaluation identities"]]'));
const summary = panel.element(By.xpath('.//div[h3[normalize-space(.)="待确认的安全摘要" or normalize-space(.)="Safe summary for confirmation"]]'));
const dialog = PageElement.located(By.css('[role="dialog"][aria-labelledby="confirm-dialog-title"]'));

export const WorldEvaluationPage = {
  navigationGroup: PageElement.located(By.css('aside nav button[aria-controls="sidebar-world-pages"]')),
  settingsNavigation: PageElement.located(By.css('aside nav a[href="#/world/settings"]')),
  modelNavigation: PageElement.located(By.css('aside nav a[href="#/world/model"]')),
  worldSelector: workspace.element(By.role('button', { name: /^(Switch world|Open an existing world|切换世界|打开已有世界)$/, exact: true })),
  tenant: workspace.element(By.role('textbox', { name: /^(Tenant ID|租户编号)$/, exact: true })),
  world: workspace.element(By.role('textbox', { name: /^(World ID|世界编号)$/, exact: true })),
  open: workspace.element(By.role('button', { name: /^(Open world|打开世界)$/, exact: true })),
  statuses: workspace.elements(By.css('.world-heading [data-status]')),
  status: workspace.element(By.css('.world-heading [data-status]')),
  errors: workspace.elements(By.css('[role="alert"]')),
  panels,
  body: panel.element(By.css('.world-panel-body[aria-busy]')),
  choose: panel.element(By.role('button', { name: /^(Choose evaluation configuration|选择评测配置)$/, exact: true })),
  refresh: panel.element(By.role('button', { name: /^(Read configuration status|读取配置状态|Read original submission's configuration status|回读原提交配置状态)$/, exact: true })),
  apply: summary.element(By.role('button', { name: /^(Confirm and save|确认并保存)$/, exact: true })),
  statusMessages: panel.elements(By.css('.world-panel-body > [role="status"]')),
  issues: panel.elements(By.css('[role="alert"]')),
  summaries: panel.elements(By.role('heading', { level: 3, name: /^(Safe summary for confirmation|待确认的安全摘要)$/, exact: true })),
  summaryRows: summary.elements(By.css('table tbody tr')),
  summaryValues: summary.elements(By.css('table tbody tr > td:nth-child(2)')),
  summaryLabels: summary.elements(By.css('table tbody tr > td:first-child')),
  identityValues: panel.elements(By.css('.world-panel-body > div:has(> table) table tbody tr > td:nth-child(2)')),
  dialog,
  dialogs: PageElements.located(By.css('[role="dialog"]')),
  confirmationMessage: dialog.element(By.css('p')),
  cancelConfirmation: dialog.element(By.role('button', { name: /^(Cancel|取消)$/, exact: true })),
  acceptConfirmation: dialog.element(By.role('button', { name: /^(Confirm|确认)$/, exact: true })),
};
