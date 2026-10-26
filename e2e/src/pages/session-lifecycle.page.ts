import type { Answerable } from '@serenity-js/core';
import { By, PageElement } from '@serenity-js/web';
import { ChatPage } from './chat.page.js';

const row = (selector: Answerable<string>) => ChatPage.session(selector).element(By.xpath('..'));
const deleteDialog = PageElement.located(By.role('dialog', { name: /^(删除 |Delete )/ }));

export const SessionLifecyclePage = {
  title: (selector: Answerable<string>) => ChatPage.session(selector).element(By.css('span.block.truncate:first-child')),
  rename: (selector: Answerable<string>) => row(selector).element(By.role('button', { name: /^(重命名会话 |Rename session )/ })),
  renameInput: ChatPage.sessionDirectory.element(By.role('textbox', { name: /^(重命名会话 |Rename session )/ })),
  saveRename: ChatPage.sessionDirectory.element(By.role('button', { name: /^(保存会话标题 |Save session title )/ })),
  cancelRename: ChatPage.sessionDirectory.element(By.role('button', { name: /^(取消重命名会话 |Cancel renaming session )/ })),
  delete: (selector: Answerable<string>) => row(selector).element(By.role('button', { name: /^(删除会话 |Delete session )/ })),
  deleteDialog,
  confirmDelete: deleteDialog.element(By.role('button', { name: /^(确认删除|Confirm Delete)$/ })),
  closeDelete: deleteDialog.element(By.role('button', { name: /^(关闭|Close)$/ })),
  send: PageElement.located(By.role('button', { name: /^(发送|Send)$/ })),
  stop: PageElement.located(By.role('button', { name: /^(停止|Stop)$/ })),
  expandedBucket: (label: Answerable<string>) => ChatPage.sessionDirectory.element(By.cssContainingText('button:has(> svg.lucide-chevron-down)', label)),
  assistant: (marker: Answerable<string>) => PageElement.located(By.cssContainingText('[data-testid="chat-message-stack"] [data-chat-item-kind="assistant-turn"]', marker)),
  user: (prompt: Answerable<string>) => PageElement.located(By.cssContainingText('[data-testid="chat-message-stack"] [data-chat-item-kind="user-message"]', prompt)),
};
