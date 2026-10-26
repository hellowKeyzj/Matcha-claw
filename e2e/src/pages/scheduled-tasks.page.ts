import type { Answerable } from '@serenity-js/core';
import { By, PageElement, PageElements } from '@serenity-js/web';

const viewport = PageElement.located(By.css('[data-page-scroll]'));
const header = viewport.element(By.css('section > header'));
const panel = viewport.element(By.role('tabpanel', { name: /^(Scheduled Tasks|定时任务)$/i }));
const createDialog = panel.element(By.role('dialog', { name: /^(Create Task|创建任务)$/i }));
const editDialog = panel.element(By.role('dialog', { name: /^(Edit Task|编辑任务)$/i }));
const confirmation = panel.element(By.role('dialog', { name: /^(Confirm|确认)$/i }));
const card = (selector: Answerable<string>) => panel.element(By.css(selector));

export const ScheduledTasksPage = {
  navigation: PageElement.located(By.css('aside nav a[href="#/tasks"]')),
  tab: viewport.element(By.role('tab', { name: /^(Scheduled Tasks|定时任务)$/i })),
  panel,
  dialogs: PageElements.located(By.role('dialog')),
  openClawChoice: header.element(By.role('radio', { name: /OpenClaw/i })),
  openClawOnly: header.element(By.role('img', { name: /OpenClaw/i })),
  selectedRuntime: header.element(By.role('radio', { checked: true })),
  runtime: (name: Answerable<string>) => header.element(By.role('radio', { name, exact: true })),
  all: panel.element(By.role('button', { name: /^(All|全部)$/i })),
  refresh: panel.element(By.role('button', { name: /^(Refresh|刷新)$/i })),
  create: panel.element(By.role('button', { name: /^(New Task|新建任务)$/i })),
  createDialog,
  editDialog,
  createName: createDialog.element(By.id('name')),
  createMessage: createDialog.element(By.id('message')),
  createOnce: createDialog.element(By.role('button', { name: /^(One-time|单次)$/i })),
  createDate: createDialog.element(By.id('once-date')),
  createTime: createDialog.element(By.id('once-time')),
  createSubmit: createDialog.element(By.role('button', { name: /^(Create Task|创建任务)$/i })),
  createCancel: createDialog.element(By.role('button', { name: /^(Cancel|取消)$/i })),
  editName: editDialog.element(By.id('name')),
  editMessage: editDialog.element(By.id('message')),
  editDate: editDialog.element(By.id('once-date')),
  editTime: editDialog.element(By.id('once-time')),
  editPeriodic: editDialog.element(By.role('button', { name: /^(Recurring|周期)$/i })),
  editCustom: editDialog.element(By.role('button', { name: /^(Custom Cron|自定义 Cron)$/i })),
  editCron: editDialog.element(By.id('cron-expr')),
  editSubmit: editDialog.element(By.role('button', { name: /^(Save Changes|保存更改)$/i })),
  editCancel: editDialog.element(By.role('button', { name: /^(Cancel|取消)$/i })),
  confirmation,
  deleteMessage: confirmation.element(By.xpath('.//p[translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz") = "are you sure you want to delete this task?" or normalize-space(.) = "确定要删除此任务吗？"]')),
  confirmDelete: confirmation.element(By.role('button', { name: /^(Delete|删除)$/i })),
  cancelDelete: confirmation.element(By.role('button', { name: /^(Cancel|取消)$/i })),
  card,
  title: (selector: Answerable<string>) => card(selector).element(By.css('[data-testid^="cron-job-card-title-"]')),
  message: (selector: Answerable<string>) => card(selector).element(By.css('p[title]:not([data-testid])')),
  toggle: (selector: Answerable<string>) => card(selector).element(By.role('switch')),
  edit: (selector: Answerable<string>) => card(selector).element(By.role('button', { name: /^(Edit|编辑)$/i })),
  delete: (selector: Answerable<string>) => card(selector).element(By.role('button', { name: /^(Delete|删除)$/i })),
  trigger: (selector: Answerable<string>) => card(selector).element(By.role('button', { name: /^(Run Now|立即运行)$/i })),
  lastRun: (selector: Answerable<string>) => card(selector).element(By.xpath('.//span[contains(concat(" ", normalize-space(@class), " "), " truncate ")][starts-with(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "last:") or starts-with(normalize-space(.), "上次运行:")]')),
  createdToast: PageElement.located(By.xpath('//*[@data-sonner-toast][translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz") = "task created" or normalize-space(.) = "任务已创建"]')),
  updatedToast: PageElement.located(By.xpath('//*[@data-sonner-toast][translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz") = "task updated" or normalize-space(.) = "任务已更新"]')),
  deletedToast: PageElement.located(By.xpath('//*[@data-sonner-toast][translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz") = "task deleted" or normalize-space(.) = "任务已删除"]')),
  triggeredToast: PageElement.located(By.xpath('//*[@data-sonner-toast][translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz") = "task triggered successfully" or normalize-space(.) = "任务已成功触发"]')),
};
