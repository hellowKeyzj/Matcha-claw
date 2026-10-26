import { By, PageElement, PageElements } from '@serenity-js/web';

const heading = PageElement.located(By.role('heading', { level: 1, name: /^(Messaging Channels|消息频道)$/, exact: true }));
const runtimeSelector = heading.element(By.xpath('..'));

export const ChannelsPage = {
  navigation: PageElement.located(By.css('aside nav a[href="#/channels"]')).describedAs('sidebar Channels navigation'),
  heading,
  total: PageElement.located(By.xpath('//span[strong and (contains(., "频道总数") or contains(., "Total Channels"))]/strong'))
    .describedAs('configured channel count'),
  available: PageElement.located(By.role('heading', { level: 2, name: /^(Available Channels|可用频道)$/, exact: true })),
  openClawSelected: runtimeSelector.element(By.css('[role="radiogroup"] [role="radio"][aria-label="OpenClaw"][aria-checked="true"], [role="img"][aria-label="OpenClaw"]')),
  matchaSelected: runtimeSelector.element(By.css('[role="radiogroup"] [role="radio"][aria-label="Matcha Agent"][aria-checked="true"], [role="img"][aria-label="Matcha Agent"]')),
  loadErrors: PageElements.located(By.css('main [class~="border-destructive"]')),
  body: PageElement.located(By.css('body')),
};
