import { By, PageElement, PageElements } from '@serenity-js/web';

const workspace = PageElement.located(By.css('main .world-workspace'));
const management = workspace.element(By.xpath('.//section[header//h2[normalize-space(.)="运行独立评测" or normalize-space(.)="Run an independent evaluation"]]'));
const registration = management.element(By.xpath('.//details[summary[normalize-space(.)="登记测试与样本文件" or normalize-space(.)="Register a test and sample files"]]'));
const freeze = management.element(By.xpath('.//details[summary[normalize-space(.)="首次冻结评测套件" or normalize-space(.)="Freeze an evaluation suite for the first time"]]'));

export const WorldOrderEvaluationPage = {
  navigationGroup: PageElement.located(By.css('aside nav button[aria-controls="sidebar-world-pages"]')),
  changesNavigation: PageElement.located(By.css('aside nav a[href="#/world/changes"]')),
  modelNavigation: PageElement.located(By.css('aside nav a[href="#/world/model"]')),
  worldSelector: workspace.element(By.role('button', { name: /^(Switch world|Open an existing world|切换世界|打开已有世界)$/, exact: true })),
  tenant: workspace.element(By.role('textbox', { name: /^(Tenant ID|租户编号)$/, exact: true })),
  world: workspace.element(By.role('textbox', { name: /^(World ID|世界编号)$/, exact: true })),
  open: workspace.element(By.role('button', { name: /^(Open world|打开世界)$/, exact: true })),
  status: workspace.element(By.css('.world-heading [data-status]')),
  errors: workspace.elements(By.css('[role="alert"]')),
  dialogs: PageElements.located(By.css('[role="dialog"]')),
  evaluationTab: workspace.element(By.role('tab', { name: /^(验证与评测|Validation and evaluation)$/, exact: true })),
  openEvaluation: workspace.element(By.role('button', { name: /^(运行评测 \/ 管理测试|Run evaluation \/ manage tests)$/, exact: true })),
  management,
  managementPanels: workspace.elements(By.xpath('.//section[header//h2[normalize-space(.)="运行独立评测" or normalize-space(.)="Run an independent evaluation"]]')),
  register: registration.element(By.role('button', { name: /^(封存文件并登记测试|Seal files and register test)$/, exact: true })),
  freezeFirst: freeze.element(By.role('button', { name: /^(首次冻结|Freeze first revision)$/, exact: true })),
  run: management.element(By.role('button', { name: /^(开始评测|Start evaluation)$/, exact: true })),
  reports: workspace.elements(By.css('article.world-document')),
};
