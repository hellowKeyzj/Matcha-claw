import type {
  OpenClawSubagentTemplateWorkflow,
  SubagentTemplateCatalogResult,
  SubagentTemplateDetail,
} from '../workflows/openclaw-workspace/openclaw-subagent-template-workflow';
export type {
  SubagentTemplateCatalogResult,
  SubagentTemplateDetail,
  TemplateCatalogEntry,
  TemplateCategoryEntry,
  TemplateFileName,
} from '../workflows/openclaw-workspace/openclaw-subagent-template-workflow';

export class SubagentTemplateService {
  constructor(
    private readonly templateWorkflow: Pick<OpenClawSubagentTemplateWorkflow, 'listCatalog' | 'getTemplate'>,
  ) {}

  async listCatalog(): Promise<SubagentTemplateCatalogResult> {
    return await this.templateWorkflow.listCatalog();
  }

  async getTemplate(templateIdRaw: unknown): Promise<SubagentTemplateDetail | null> {
    return await this.templateWorkflow.getTemplate(templateIdRaw);
  }
}
