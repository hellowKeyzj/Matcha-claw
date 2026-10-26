import type { Answerable } from '@serenity-js/core';
import { By, PageElement, PageElements } from '@serenity-js/web';
import { ChatPage } from './chat.page.js';

const messages = PageElement.located(By.css('[data-testid="chat-message-stack"]'));

const matchaRuntime = ChatPage.switchboard.element(By.xpath('.//section[.//h3[contains(., "Matcha")]]'));

export const MatchaHistoryPage = {
  newDraft: (selector: Answerable<string>) => matchaRuntime.element(By.css(selector)),
  switchboards: PageElements.located(By.css('[data-testid="chat-switchboard"]')),
  expandedBucket: (label: Answerable<string>) => ChatPage.sessionDirectory.element(By.cssContainingText('button:has(> svg.lucide-chevron-down)', label)),
  userMessage: messages.element(By.css('[data-chat-item-kind="user-message"]')),
  assistantTurn: messages.element(By.css('[data-chat-item-kind="assistant-turn"]')),
  send: PageElement.located(By.role('button', { name: /^(发送|Send)$/ })),
  exportMarkdown: PageElement.located(By.role('button', { name: /^(导出 Markdown|Export Markdown|Markdown をエクスポート)$/i })),
};
