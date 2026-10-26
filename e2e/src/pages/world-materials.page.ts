import { By, PageElement } from '@serenity-js/web';

const workspace = PageElement.located(By.css('main .world-workspace'));
const materials = workspace.element(By.role('tabpanel', { name: /^(Data sources|资料来源)$/, exact: true }));
const uploadResult = materials.element(By.role('region', { name: /^(Upload progress|上传进度)$/, exact: true }));
const records = workspace.element(By.role('region', { name: /^(Processing records|处理记录)$/, exact: true }));
const draft = materials.element(By.xpath('.//section[header//h2[normalize-space(.)="Review draft" or normalize-space(.)="审阅草稿"]]'));
const readback = draft.element(By.xpath('.//details[summary[normalize-space(.)="Read source and parsed content" or normalize-space(.)="读取来源与解析内容"]]'));

export const WorldMaterialsPage = {
  dataNavigation: PageElement.located(By.css('aside nav a[href="#/world"]')),
  settingsNavigation: PageElement.located(By.css('aside nav a[href="#/world/settings"]')),
  operationsTab: workspace.element(By.role('tab', { name: /^(Processing records|处理记录)$/, exact: true })),
  materialsTab: workspace.element(By.role('tab', { name: /^(Data sources|资料来源)$/, exact: true })),
  session: records.element(By.role('combobox', { name: /^(Records from this session|本次会话记录)$/, exact: true })),
  refresh: workspace.element(By.css('.world-heading')).element(By.role('button', { name: /^(Refresh|刷新)$/, exact: true })),
  uploadResult,
  rejectionDiagnosticSummary: uploadResult.element(By.css('[role="alert"] details > summary')),
  closedRejectionDiagnostics: uploadResult.elements(By.css('[role="alert"] details:not([open])')),
  failures: uploadResult.elements(By.css('[role="alert"]')),
  pending: uploadResult.elements(By.xpath('.//*[@role="status"][normalize-space(.)="The result is unconfirmed. Continue checking the original request." or normalize-space(.)="结果待核对，请使用原请求继续核对。"]')),
  incomplete: uploadResult.elements(By.xpath('.//span[normalize-space(.)="Incomplete; check the receipt" or normalize-space(.)="未完成，请核对回执"]')),
  upload: materials.element(By.css('nav.world-entry-grid button:first-child')),
  review: materials.element(By.css('nav.world-entry-grid button:nth-child(4)')),
  scope: materials.element(By.role('combobox', { name: /^(Business scope|业务范围)$/, exact: true })),
  access: materials.element(By.role('combobox', { name: /^(Access policy|访问策略)$/, exact: true })),
  retention: materials.element(By.role('combobox', { name: /^(Retention policy|保留策略)$/, exact: true })),
  budgetSummary: materials.element(By.xpath('.//details/summary[normalize-space(.)="Processing limits" or normalize-space(.)="本次处理上限"]')),
  wallTime: materials.element(By.role('textbox', { name: /^(Maximum time \(ms\)|最长时间（毫秒）)$/, exact: true })),
  steps: materials.element(By.role('textbox', { name: /^(Processing steps|处理步骤)$/, exact: true })),
  sourceReads: materials.element(By.role('textbox', { name: /^(Source reads|来源读取次数)$/, exact: true })),
  rows: materials.element(By.role('textbox', { name: /^(Maximum records|最大记录数)$/, exact: true })),
  bytes: materials.element(By.role('textbox', { name: /^(Bytes processed|处理字节数)$/, exact: true })),
  modelCalls: materials.element(By.role('textbox', { name: /^(Model calls|模型调用次数)$/, exact: true })),
  inputTokens: materials.element(By.role('textbox', { name: /^(Input tokens|输入 token)$/, exact: true })),
  outputTokens: materials.element(By.role('textbox', { name: /^(Output tokens|输出 token)$/, exact: true })),
  file: materials.element(By.css('input[type="file"]')),
  accepted: uploadResult.elements(By.xpath('.//span[normalize-space(.)="Materials uploaded; import accepted" or normalize-space(.)="资料已上传，导入已受理"]')),
  tracePhases: records.elements(By.css('aside .world-status[data-status]')),
  tracePhase: records.element(By.css('aside .world-status[data-status]')),
  draftButtons: records.elements(By.role('button', { name: /^(Review draft|审阅草稿)/ })),
  draftButton: records.element(By.role('button', { name: /^(Review draft|审阅草稿)/ })),
  candidateRows: draft.elements(By.css(':scope > .world-panel-body > .world-table:first-child tbody tr:has(details)')),
  draft,
  readback,
  readbackSummary: readback.element(By.css(':scope > summary')),
  closedReadback: draft.elements(By.xpath('.//details[not(@open)][summary[normalize-space(.)="Read source and parsed content" or normalize-space(.)="读取来源与解析内容"]]')),
  source: readback.element(By.role('combobox', { name: /^(Source versions|来源版本)$/, exact: true })),
  artifact: readback.element(By.role('combobox', { name: /^(Parse artifacts|解析制品)$/, exact: true })),
  readSource: readback.element(By.role('button', { name: /^(Read exact source version|读取精确来源版本)$/, exact: true })),
  readArtifact: readback.element(By.role('button', { name: /^(Read parsed content|读取解析内容)$/, exact: true })),
};
