import type { Answerable } from '@serenity-js/core';
import { By, PageElement, PageElements } from '@serenity-js/web';

const viewport = PageElement.located(By.css('[data-page-scroll]'));
const header = viewport.element(By.css('section > header'));
const longTasks = viewport.element(By.role('tabpanel', { name: /^(Long Tasks|长任务)$/i }));
const directorySelector = '[data-task-list-scroll="true"]';
const directory = longTasks.element(By.css(directorySelector));
const detail = (subject: Answerable<string>) => longTasks.element(By.css('div.flex.h-\\[70vh\\]')).closestTo(
  longTasks.element(By.role('heading', { level: 3, name: subject, exact: true })),
);
const deleteDialog = viewport.element(By.role('dialog', { name: /^(Confirm|确认)$/i }));

export const TasksLifecyclePage = {
  navigation: PageElement.located(By.css('aside nav a[href="#/tasks"]')),
  dialogs: PageElements.located(By.role('dialog')),
  openClawChoice: header.element(By.role('radio', { name: /OpenClaw/i })),
  openClawOnly: header.element(By.role('img', { name: /OpenClaw/i })),
  selectedRuntime: header.element(By.role('radio', { checked: true })),
  runtime: (name: Answerable<string>) => header.element(By.role('radio', { name, exact: true })),
  longTasksTab: viewport.element(By.role('tab', { name: /^(Long Tasks|长任务)$/i })),
  longTasks,
  scope: longTasks.element(By.role('combobox', { name: /^(Scope|范围)$/i })),
  timeRange: longTasks.element(By.role('combobox', { name: /^(Time Range|时间范围)$/i })),
  all: longTasks.element(By.role('button', { name: /^(All|全部)$/i })),
  refresh: longTasks.element(By.role('button', { name: /^(Refresh|刷新)$/i })),
  errors: longTasks.elements(By.role('alert')),
  directorySelector,
  directory,
  loadMore: directory.element(By.role('button', { name: /^(Load more|加载更多)$/i })),
  title: (subject: Answerable<string>) => directory.element(By.cssContainingText('p', subject)),
  row: (subject: Answerable<string>) => directory.element(By.cssContainingText('p', subject)).element(By.xpath('ancestor::button[1]')),
  rowStatus: (subject: Answerable<string>) => directory.element(By.cssContainingText('p', subject))
    .element(By.xpath('ancestor::button[1]')).element(By.css('span[aria-label]')),
  detail,
  detailId: (subject: Answerable<string>) => detail(subject).element(By.css('h3 + p.break-all')),
  deleteTask: (subject: Answerable<string>) => detail(subject).element(By.role('button', { name: /^(Delete Task|删除任务)$/i })),
  deleteDialog,
  confirmDelete: deleteDialog.element(By.role('button', { name: /^(Delete|删除)$/i })),
  cancelDelete: deleteDialog.element(By.role('button', { name: /^(Cancel|取消)$/i })),
};
