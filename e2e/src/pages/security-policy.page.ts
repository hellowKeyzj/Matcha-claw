import { By, PageElement } from '@serenity-js/web';

export const SecurityPolicyPage = {
  heading: PageElement.located(By.role('heading', { level: 1, name: /^(Security|安全)$/ })).describedAs('security policy heading'),
  runtimeSection: PageElement.located(By.role('navigation', { name: /^(Security sections|安全分区)$/ }))
    .element(By.role('button', { name: /^(Runtime Switches|运行时开关)$/ })).describedAs('runtime security switches'),
  guardsSection: PageElement.located(By.role('navigation', { name: /^(Security sections|安全分区)$/ }))
    .element(By.role('button', { name: /^(Policy Guards Extension|策略防护扩展)$/ })).describedAs('policy guards extension'),
  guard: PageElement.located(By.xpath('//label[span[normalize-space(.)="Enable runtime guard" or normalize-space(.)="启用运行时守卫"]]//*[@role="switch"]'))
    .describedAs('runtime guard switch'),
  injectionGuard: PageElement.located(By.xpath('//label[span[normalize-space(.)="Block prompt injection" or normalize-space(.)="拦截 prompt injection"]]//*[@role="switch"]'))
    .describedAs('prompt injection guard switch'),
  patterns: PageElement.located(By.xpath('//div[label[normalize-space(.)="Prompt-injection extension patterns" or normalize-space(.)="提示词注入扩展规则"]]/textarea'))
    .describedAs('prompt injection patterns'),
  save: PageElement.located(By.role('button', { name: /^(Save Policy|保存策略)$/ })).describedAs('save security policy'),
  unsaved: PageElement.located(By.xpath('//header//*[normalize-space(.)="Unsaved changes" or normalize-space(.)="未保存改动"]'))
    .describedAs('security policy unsaved changes'),
  saved: PageElement.located(By.xpath('//li[@data-sonner-toast and @data-type="success"]//div[@data-title and (normalize-space(.)="Security policy saved." or normalize-space(.)="安全策略已保存。")]'))
    .describedAs('real security policy saved confirmation'),
};
