import { By, PageElement } from '@serenity-js/web';

const main = PageElement.located(By.css('main'));
const createDialog = PageElement.located(By.role('dialog', { name: '创建团队', exact: true }));
const teamList = main.element(By.xpath('.//h2[normalize-space(.)="团队列表"]/parent::div'));

export const TeamBoundariesPage = {
  navigation: PageElement.located(By.css('aside nav a[href="#/teams"]')),
  title: main.element(By.role('heading', { name: '团队', level: 1, exact: true })),
  teamList,
  teamNames: teamList.elements(By.css('.truncate.text-sm.font-medium')),
  emptyTeamList: teamList.element(By.xpath('./div/div[normalize-space(.)="暂无团队"]')),
  openCreate: main.element(By.role('button', { name: '创建团队', exact: true })),
  createDialog,
  teamSkillTab: createDialog.element(By.role('tab', { name: '加载 TeamSkill', exact: true })),
  choosePackage: createDialog.element(By.role('button', { name: '选择 TeamSkill 包', exact: true })),
  chooseDirectory: PageElement.located(By.role('menuitem', { name: '选择目录', exact: true })),
  alert: createDialog.element(By.role('alert')),
  create: createDialog.element(By.css('footer')).element(By.role('button', { name: '创建团队', exact: true })),
  cancel: createDialog.element(By.css('footer')).element(By.role('button', { name: '取消', exact: true })),
};
