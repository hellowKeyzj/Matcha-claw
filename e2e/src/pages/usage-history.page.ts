import { By, PageElement, PageElements } from '@serenity-js/web';

const summary = (chinese: string, english: string) => PageElement.located(By.xpath(
  `//main//section/div[p[normalize-space()="${chinese}" or normalize-space()="${english}"]]/p[2]`,
));

export const UsageHistoryPage = {
  navigation: PageElement.located(By.css('aside nav a[href="#/dashboard"]')),
  heading: PageElement.located(By.role('heading', { level: 1, name: /^(Token 用量|Token usage)$/ })),
  selectedRuntime: PageElement.located(By.css('main header [role="radiogroup"] [role="radio"][aria-checked="true"], main header [role="img"][aria-label]')),
  empty: PageElement.located(By.xpath('//main//p[normalize-space()="还没有 token 消耗历史" or normalize-space()="No token usage history yet"]')),
  emptyWindow: PageElement.located(By.xpath('//main//p[normalize-space()="当前时间范围内没有 token 消耗历史" or normalize-space()="No token usage history in this time range"]')),
  errors: PageElements.located(By.xpath('//main//p[contains(., "刷新 token 消耗历史失败") or contains(., "Failed to refresh token usage history") or normalize-space()="运行时不可用" or normalize-space()="Runtime unavailable" or normalize-space()="不支持" or normalize-space()="Unsupported" or normalize-space()="尚未就绪" or normalize-space()="Not ready"]')),
  loading: PageElements.located(By.xpath('//main//*[normalize-space()="正在加载 token 消耗历史..." or normalize-space()="Loading token usage history..."]')),
  records: PageElement.located(By.xpath('//main//section/p[starts-with(normalize-space(), "共 ") or contains(., " records")]')),
  pagination: PageElement.located(By.xpath('//main//section//p[starts-with(normalize-space(), "第 ") or starts-with(normalize-space(), "Page ")]')),
  sevenDays: PageElement.located(By.role('button', { name: /^(7 天|7 days)$/ })),
  thirtyDays: PageElement.located(By.role('button', { name: /^(30 天|30 days)$/ })),
  allTime: PageElement.located(By.role('button', { name: /^(全部|All)$/ })),
  rows: PageElements.located(By.xpath('//main//section//button[span[normalize-space()="展开 session 明细" or normalize-space()="收起 session 明细" or normalize-space()="Show session details" or normalize-space()="Hide session details"]]/ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-lg ")][1]')),
  totalTokens: summary('总 token', 'total tokens'),
  inputTokens: summary('输入', 'Input'),
  outputTokens: summary('输出', 'Output'),
  cacheTokens: summary('缓存', 'Cache'),
};
