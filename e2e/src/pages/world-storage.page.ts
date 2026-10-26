import { By } from '@serenity-js/web';
import { WorldWorkspacePage } from './world-workspace.page.js';

const workspace = WorldWorkspacePage.workspace;
const storage = workspace.element(By.role('tabpanel', { name: /^(Storage and setup|存储与初始化)$/, exact: true }));
const panel = storage.element(By.css('section:has(> header > h2:text-is("Connect and enable storage")), section:has(> header > h2:text-is("连接并启用存储"))'));

export const WorldStoragePage = {
  navigationGroup: WorldWorkspacePage.navigationGroup,
  settingsNavigation: WorldWorkspacePage.settingsNavigation,
  settingsHeading: WorldWorkspacePage.settingsHeading,
  storageTab: workspace.element(By.role('tab', { name: /^(Storage and setup|存储与初始化)$/, exact: true })),
  panel,
  heading: panel.element(By.role('heading', { level: 2, name: /^(Connect and enable storage|连接并启用存储)$/, exact: true })),
  connection: panel.element(By.css('input[type="password"]')),
  connect: panel.element(By.role('button', { name: /^(Connect and enable|连接并启用)$/, exact: true })),
  storageId: panel.element(By.css('form > p.font-mono')),
  ready: workspace.element(By.css('.world-context-bar [data-status="ready"]')),
  statuses: workspace.elements(By.css('.world-context-bar [data-status]')),
  activeRelease: workspace.element(By.css('.world-context-bar span[title]')),
  world: workspace.element(By.css('.world-footer > span[title]')),
  errors: workspace.elements(By.css('[role="alert"]')),
};
