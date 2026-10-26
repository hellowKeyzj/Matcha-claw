import type { Answerable } from '@serenity-js/core';
import { By, PageElement, PageElements } from '@serenity-js/web';
import { AgentPage } from './agent.page.js';

const editor = PageElement.located(By.role('dialog', { name: /^(编辑子Agent|Edit Subagent)$/i }));

export const SubagentsPage = {
  editor,
  editDialogs: PageElements.located(By.role('dialog', { name: /^(编辑子Agent|Edit Subagent)$/i })),
  gridView: PageElement.located(By.css('main')).element(By.role('button', { name: /^(网格视图|Grid view)$/i })),
  edit: (selector: Answerable<string>) => AgentPage.card(selector).element(By.role('button', { name: /^(编辑|Edit) /i })),
  skillsTab: editor.element(By.role('tab', { name: /^(技能|Skills)$/i })),
  toolsTab: editor.element(By.role('tab', { name: /^(Tool|Tools)$/i })),
  inheritSkills: editor.element(By.role('switch', { name: /^(使用全部技能|Use all skills)$/i })),
  inheritTools: editor.element(By.role('switch', { name: /^(继承默认工具|Inherit default tools)$/i })),
  skillSwitches: editor.elements(By.role('switch', { name: /^(切换技能|Toggle skill) /i })),
  skill: (label: Answerable<string>) => editor.element(By.role('switch', { name: label, exact: true })),
  toolProfile: editor.element(By.css('#subagent-tool-profile')),
  save: editor.element(By.role('button', { name: /^(保存|Save)$/i })),
  close: editor.element(By.role('button', { name: /^(关闭|Close)$/i })),
};
