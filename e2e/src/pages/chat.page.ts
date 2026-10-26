import type { Answerable } from '@serenity-js/core';
import { By, PageElement, PageElements } from '@serenity-js/web';

const switchboard = PageElement.located(By.css('[data-testid="chat-switchboard"]'));
const openClaw = switchboard.element(By.xpath('.//section[.//h3[contains(., "OpenClaw")]]'));
const sidePanel = PageElement.located(By.css('[data-testid="chat-side-panel"]'));
const workspace = sidePanel.element(By.css('[data-testid="workspace-browser-body"]'));
const composer = PageElement.located(By.css('[data-testid="chat-composer"]'));
const messages = PageElement.located(By.css('[data-testid="chat-message-stack"]'));
const sentUserRow = messages.element(By.xpath('.//*[@data-chat-item-kind="user-message"][.//p[normalize-space(.)="Describe this image."]]'));
const sessionDirectory = switchboard.element(By.css('[data-testid="session-list-scroll-area"]'));

export const ChatPage = {
  workspaceHost: PageElement.located(By.css('[data-testid="chat-workspace-host"]')).describedAs('Chat workspace'),
  newChat: PageElement.located(By.role('button', { name: /^(New Chat|新对话)$/i })).describedAs('sidebar Chat navigation'),
  otherPage: PageElement.located(By.css('[data-page-scroll]')).describedAs('non-Chat page viewport'),
  fullscreenPanel: PageElement.located(By.css('[data-testid="chat-side-panel"][data-artifact-fullscreen="true"]')),
  input: PageElement.located(By.css('textarea[data-testid="chat-composer-input"]')).describedAs('Chat input'),
  identity: PageElement.located(By.css('[data-testid="agent-session-identity-beacon"]')).describedAs('selected Agent identity'),
  switchboard,
  switchboardBackdrop: PageElement.located(By.css('[data-testid="chat-switchboard-backdrop"]')).describedAs('close the quick switch dialog'),
  agentsTab: switchboard.element(By.role('button', { name: /^(Agent|Agents)$/i })),
  sessionsTab: switchboard.element(By.role('button', { name: /^(Sessions|会话)$/i })),
  agent: (selector: Answerable<string>) => openClaw.element(By.css(selector)),
  openClawAgent: openClaw.element(By.css('[data-testid="agent-item-main"]')),
  newOpenClawSession: openClaw.element(By.css('[data-testid="agent-new-session-main"]')),
  sessionErrors: PageElements.located(By.css('[data-testid="session-list-error"]')),
  sessions: PageElements.located(By.css('[data-testid="session-list-scroll-area"] [data-testid^="session-avatar-"]')),
  sessionDirectory,
  sessionListLoading: sessionDirectory.element(By.css('[data-testid="session-list-loading"]')),
  sessionDirectoryContents: sessionDirectory.elements(By.role('button')),
  emptySessionDirectory: sessionDirectory.element(By.css('p:not([data-testid])')),
  normalSessionsTab: sessionDirectory.element(By.role('tab', { name: /^(Normal|普通|会话)\s+\d+$/i })),
  collapsedSessionBuckets: sessionDirectory.elements(By.css('button:has(> svg.lucide-chevron-right)')),
  currentSessions: sessionDirectory.elements(By.css('.bg-secondary.text-foreground > button [data-testid^="session-avatar-"]')),
  session: (selector: Answerable<string>) => sessionDirectory.element(By.css(selector)).element(By.xpath('ancestor::button[1]')),
  sidePanel,
  openSidePanel: PageElement.located(By.role('button', { name: /^(打开右侧栏|Open side panel)$/i })),
  closeSidePanel: sidePanel.element(By.role('button', { name: /^(关闭右侧栏|Close side panel)$/i })),
  sidePanelTab: (selector: Answerable<string>) => sidePanel.element(By.css(selector)),
  activeArtifactSection: sidePanel.element(By.css('[data-testid^="chat-artifact-section-"][data-state="active"]')),
  artifactSection: (selector: Answerable<string>) => sidePanel.element(By.css(selector)),
  artifactFullscreen: sidePanel.element(By.css('[data-testid="chat-side-panel-artifact-fullscreen-toggle"]')),
  artifactsTab: sidePanel.element(By.css('[data-testid="chat-side-panel-tab-artifacts"]')),
  workspaceTab: sidePanel.element(By.css('[data-testid="chat-artifact-section-workspace"]')),
  workspace,
  expandWorkspaceTree: workspace.element(By.css('[data-testid="workspace-tree-collapse-toggle"][aria-expanded="false"]')),
  agentsFile: workspace.element(By.role('button', { name: 'AGENTS.md', exact: true })),
  previewTitle: workspace.element(By.cssContainingText('p', 'AGENTS.md')),
  previewHeading: workspace.element(By.css('.chat-markdown')).element(By.role('heading', { level: 1 })),
  preview: workspace.element(By.css('.chat-markdown')),
  readyPng: composer.element(By.role('button', { name: 'Preview e2e-attachment.png', exact: true })),
  send: composer.element(By.css('[data-chat-control="send"]')),
  userMessages: PageElements.located(By.css('[data-testid="chat-message-stack"] [data-chat-item-kind="user-message"]')),
  sentText: sentUserRow.element(By.cssContainingText('p', 'Describe this image.')),
  sentImage: sentUserRow.element(By.css('img:not([alt="user-avatar"])')),
  sentImagePreview: sentUserRow.element(By.css('img:not([alt="user-avatar"])')),
  sentUserRow,
  body: PageElement.located(By.css('body')),
};
