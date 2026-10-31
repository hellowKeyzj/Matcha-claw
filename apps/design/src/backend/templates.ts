import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { templatePromptLimits, type DesignTemplate, type TemplateCategory, type TemplateInput, type TemplatesRequest, type TemplatesResult } from '../templates';
import type { Assets } from './assets';
import { DesignError, readJson, writeAtomic } from './files';
import { id, invalid, object, text } from './validation';

function category(value: unknown): TemplateCategory {
  if (value !== 'product-scene' && value !== 'model' && value !== 'logo-technique') invalid('Unknown template category.');
  return value;
}

function templateInput(value: unknown, stored = false): TemplateInput {
  const raw = object(value, ['category', 'title', 'description', 'prompt', 'assetId']);
  const templateCategory = category(raw.category);
  return { category: templateCategory, title: text(raw.title, 'title', 200).trim(),
    description: text(raw.description, 'description', 2000, true).trim(),
    prompt: text(raw.prompt, 'prompt', stored ? 8000 : templatePromptLimits[templateCategory]).trim(),
    assetId: id(raw.assetId, 'assetId') };
}

function request(value: unknown): TemplatesRequest {
  const raw = object(value, ['action', 'category', 'template', 'templateId']);
  switch (raw.action) {
    case 'list':
      object(raw, ['action', 'category']);
      return { action: 'list', ...(raw.category === undefined ? {} : { category: category(raw.category) }) };
    case 'save':
      object(raw, ['action', 'template']);
      return { action: 'save', template: templateInput(raw.template) };
    case 'remove':
      object(raw, ['action', 'templateId']);
      return { action: 'remove', templateId: id(raw.templateId, 'templateId') };
    default: return invalid('Template action must be list, save or remove.');
  }
}

export function createTemplates(storagePath: string, assets: Assets) {
  const path = join(storagePath, 'templates.json');
  let pending: Promise<unknown> = Promise.resolve();
  let queued = 0;

  async function read(): Promise<DesignTemplate[]> {
    let value: unknown;
    try {
      if ((await stat(path)).size > 16 * 1024 * 1024) throw new DesignError('catalog_full', 'The local template catalog exceeds 16 MiB.');
      value = await readJson(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const raw = object(value, ['formatVersion', 'templates']);
    if (raw.formatVersion !== 1 || !Array.isArray(raw.templates) || raw.templates.length > 256) invalid('Invalid local template catalog.');
    const templates = raw.templates.map((value) => {
      const entry = object(value, ['id', 'category', 'title', 'description', 'prompt', 'assetId']);
      const { id: templateId, ...input } = entry;
      return { id: id(templateId, 'templateId'), ...templateInput(input, true) };
    });
    if (new Set(templates.map((entry) => entry.id)).size !== templates.length) invalid('Duplicate local template IDs.');
    return templates;
  }

  async function validateAsset(assetId: string): Promise<void> {
    const asset = await assets.get(assetId);
    if (!asset.mimeType.startsWith('image/')) invalid('A template must reference an imported image asset.');
    try {
      const file = await stat(assets.path(assetId));
      if (!file.isFile() || !file.size || file.size > 64 * 1024 * 1024) invalid('The template image is empty or exceeds 64 MiB.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DesignError('asset_not_found', `Template image ${assetId} is missing. Reimport it before saving a template.`);
      throw error;
    }
  }

  async function run(value: unknown, signal: AbortSignal): Promise<TemplatesResult> {
    const input = request(value);
    signal.throwIfAborted();
    if (queued >= 128) throw new DesignError('busy', 'Too many pending template operations. Wait for the current operation to finish.');
    const next = pending.catch(() => {}).then(async (): Promise<TemplatesResult> => {
      signal.throwIfAborted();
      let templates = await read();
      if (input.action === 'list') {
        if (input.category) templates = templates.filter((entry) => entry.category === input.category);
        for (const entry of templates) {
          signal.throwIfAborted();
          await validateAsset(entry.assetId);
        }
        signal.throwIfAborted();
        return { templates };
      }
      if (input.action === 'save') {
        if (templates.length >= 256) throw new DesignError('catalog_full', 'The local catalog contains 256 templates. Remove a template before saving another.');
        await validateAsset(input.template.assetId);
        templates.push({ id: randomUUID(), ...input.template });
      } else {
        if (!templates.some((entry) => entry.id === input.templateId)) throw new DesignError('not_found', `Template ${input.templateId} does not exist. Refresh the catalog.`);
        templates = templates.filter((entry) => entry.id !== input.templateId);
      }
      signal.throwIfAborted();
      await writeAtomic(path, { formatVersion: 1, templates });
      return { templates };
    });
    queued++;
    pending = next;
    try { return await next; } finally { queued--; }
  }

  async function drain(): Promise<void> { await pending.catch(() => {}); }
  return { run, drain };
}
