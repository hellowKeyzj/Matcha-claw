export type TemplateCategory = 'product-scene' | 'model' | 'logo-technique';

export const templatePromptLimits: Record<TemplateCategory, number> = {
  'product-scene': 8000, model: 8000, 'logo-technique': 2000,
};

export interface TemplateInput {
  category: TemplateCategory;
  title: string;
  description: string;
  prompt: string;
  assetId: string;
}

export interface DesignTemplate extends TemplateInput {
  id: string;
}

export type TemplatesRequest =
  | { action: 'list'; category?: TemplateCategory }
  | { action: 'save'; template: TemplateInput }
  | { action: 'remove'; templateId: string };

export interface TemplatesResult {
  templates: DesignTemplate[];
}
