import { f, type Answerable } from '@serenity-js/core';
import { By, PageElement } from '@serenity-js/web';

const dialog = PageElement.located(By.role('dialog', { name: '创建团队', exact: true }));
const canvas = PageElement.located(By.css('[data-team-graph-canvas="true"]'));
const teamList = PageElement.located(By.xpath('//main//h2[normalize-space(.)="团队列表"]/parent::div'));
const teamRow = (name: Answerable<string>) => teamList.element(By.xpath(f`.//div[@class="truncate text-sm font-medium" and normalize-space(.)="${name}"]/../..`));

export const TeamLifecyclePage = {
  navigation: PageElement.located(By.css('aside nav a[href="#/teams"]')),
  heading: PageElement.located(By.role('heading', { level: 1, name: '团队', exact: true })),
  openCreate: PageElement.located(By.css('main header')).element(By.role('button', { name: '创建团队', exact: true })),
  teamList,
  teamNames: teamList.elements(By.css('.truncate.text-sm.font-medium')),
  emptyTeamList: teamList.element(By.xpath('./div/div[normalize-space(.)="暂无团队"]')),
  teamRow,
  openTeam: (name: Answerable<string>) => teamRow(name).element(By.role('button', { name: '打开', exact: true })),
  deleteTeam: (name: Answerable<string>) => teamRow(name).element(By.role('button', { name: '删除', exact: true })),
  dialog,
  name: dialog.element(By.css('#team-name')),
  loadSkill: dialog.element(By.role('tab', { name: '加载 TeamSkill', exact: true })),
  choosePackage: dialog.element(By.role('button', { name: '选择 TeamSkill 包', exact: true })),
  chooseDirectory: PageElement.located(By.role('menuitem', { name: '选择目录', exact: true })),
  selectedPath: dialog.element(By.css('p[title]')),
  packageIdentity: dialog.element(By.xpath('.//h3[@id="team-preview-title"]/following-sibling::div/div[1]/div[1]')),
  dependencies: dialog.element(By.xpath('.//div[normalize-space(.)="依赖准备"]/following-sibling::div')),
  existingTeam: dialog.element(By.role('button', { name: '打开已有团队', exact: true })),
  replaceTeam: dialog.element(By.role('button', { name: '替换团队', exact: true })),
  create: dialog.element(By.css('footer')).element(By.role('button', { name: '创建团队', exact: true })),
  cancelDialog: dialog.element(By.css('footer')).element(By.role('button', { name: '取消', exact: true })),
  detailHeading: (name: Answerable<string>) => PageElement.located(By.role('heading', { level: 1, name, exact: true })),
  runHistory: PageElement.located(By.role('combobox', { name: '运行记录', exact: true })),
  canvas,
  graph: canvas.element(By.css('[aria-label="工作流画布"]')),
  nodes: canvas.elements(By.css('[data-node-id]')),
  stopRun: PageElement.located(By.role('button', { name: '停止运行', exact: true })),
  deleteRun: PageElement.located(By.role('button', { name: '删除 run', exact: true })),
  backToList: PageElement.located(By.role('button', { name: '返回团队列表', exact: true })),
};
