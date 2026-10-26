import { By, PageElement } from '@serenity-js/web';

const heading = PageElement.located(By.role('heading', { name: /^(消息频道|Messaging Channels)$/, exact: true }));
const sandboxCard = PageElement.located(By.xpath(
  '//div[contains(concat(" ", normalize-space(@class), " "), " h-full ") and contains(@class, "shell-surface-muted") and .//p[normalize-space(.)="Feishu / Lark"]]',
)).describedAs('the configured Feishu sandbox card, never the available-channel tile');

export const ChannelControlPage = {
  navigation: PageElement.located(By.css('aside nav a[href="#/channels"]')),
  heading,
  currentOpenClaw: heading.element(By.xpath('..')).element(By.css(
    '[role="radiogroup"] [role="radio"][aria-checked="true"][aria-label="OpenClaw"], [role="img"][aria-label="OpenClaw"]',
  )).describedAs('selected OpenClaw management runtime; select the local runtime before this sandbox scenario'),
  refresh: PageElement.located(By.role('button', { name: /^(刷新|Refresh)$/, exact: true })),
  body: PageElement.located(By.css('body')),
  sandboxCard,
  connected: sandboxCard.element(By.xpath('.//*[not(*) and (normalize-space(.)="已连接" or normalize-space(.)="Connected")]')),
  disconnected: sandboxCard.element(By.xpath('.//*[not(*) and (normalize-space(.)="未连接" or normalize-space(.)="Disconnected")]')),
};
