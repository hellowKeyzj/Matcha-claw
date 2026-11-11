import type { AppToolHandler, AppToolResult } from '@matcha/app-plugins-sdk';
import { OfficeError, errorMessage } from '../errors';
import { extname } from 'node:path';
import type { DocumentService } from './service';
import type { DocumentType } from './model';
import { typeFromName } from './store';
import { sourceText } from './text';
import {
  decodeBase64, documentId, enumValue, integer, invalid, object, optionalBoolean,
  optionalText, resourcesInput, resourcesOutput, revision, text
} from './validation';

function result(summary: string, structuredContent: Record<string, unknown>): AppToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent };
}

function defaultName(type: DocumentType): string {
  return `Untitled ${new Date().toISOString().slice(0, 10)}.${type}`;
}

export function createDocumentTools(documents: DocumentService): Record<string, AppToolHandler> {
  const tools: Record<string, AppToolHandler> = {};

  function register(name: string, handler: AppToolHandler): void {
    tools[name] = async (input, tool) => {
      try {
        tool.signal.throwIfAborted();
        return await handler(input, tool);
      } catch (error) {
        const message = errorMessage(error);
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          structuredContent: {
            code: error instanceof OfficeError ? error.code : tool.signal.aborted ? 'interrupted' : 'operation_failed',
            error: message,
            ...(error instanceof OfficeError ? error.detail : undefined)
          }
        };
      }
    };
  }

  register('documents_list', async (input) => {
    object(input, []);
    const listed = await documents.list();
    return result(`${listed.length} document(s).`, { documents: listed });
  });

  register('document_create', async (input) => {
    const raw = object(input, ['type', 'name', 'source', 'sourceFormat', 'header', 'resources']);
    const type = enumValue(raw.type, 'type', ['docx', 'xlsx', 'csv', 'pptx', 'pdf', 'md', 'html', 'txt', 'json'] as const);
    const source = type === 'pdf' && raw.source === undefined ? '' : type === 'md' || type === 'html' || type === 'txt' || type === 'json' || type === 'csv' || type === 'pdf' ? sourceText(raw.source) : text(raw.source, 'source', 8_000_000);
    if (type === 'pdf' && source) invalid('Blank PDF creation does not accept source; import or convert an existing document instead.');
    const name = optionalText(raw.name, 'name', 200) ?? defaultName(type);
    const allowedFormats = type === 'docx' ? ['markdown', 'html'] as const
      : type === 'xlsx' ? ['json', 'csv'] as const
        : type === 'csv' ? ['csv'] as const
        : type === 'pptx' ? ['spec', 'ops'] as const
          : type === 'md' ? ['markdown'] as const : type === 'html' ? ['html'] as const
            : type === 'txt' ? ['text'] as const : type === 'json' ? ['json'] as const : ['blank'] as const;
    const sourceFormat = raw.sourceFormat === undefined
      ? undefined
      : enumValue(raw.sourceFormat, 'sourceFormat', allowedFormats);
    const header = optionalBoolean(raw.header, 'header');
    if (raw.resources !== undefined && type !== 'md' && type !== 'html') invalid('resources are only supported for Markdown and HTML documents.');
    const resources = resourcesInput(raw.resources, 8_000_000, source.length);
    const { document, result: created } = await documents.create({ type, name, source, sourceFormat, header, resources, ...(type === 'pdf' && raw.name === undefined ? { autoNamePending: true as const } : {}) });
    return result(`Created ${document.name}.`, {
      document,
      summary: typeof created.summary === 'string' ? created.summary : '',
      warnings: created.warnings ?? []
    });
  });

  register('document_import', async (input, tool) => {
    const raw = object(input, ['name', 'mimeType', 'data', 'resources']);
    const name = text(raw.name, 'name', 200);
    const mimeType = text(raw.mimeType, 'mimeType', 200);
    const extension = extname(name).slice(1).toLowerCase();
    const type = typeFromName(name, mimeType);
    const data = text(raw.data, 'data', 80_000_000);
    const bytes = decodeBase64(data);
    if (raw.resources !== undefined && (type !== 'md' && type !== 'html' || ['xlsm', 'xls', 'csv', 'tsv', 'ods', 'ots', 'ppt', 'odp', 'otp', 'doc', 'dot', 'odt', 'ott', 'hwp', 'hwpx'].includes(extension))) invalid('resources are only supported for Markdown and HTML documents.');
    const resources = resourcesInput(raw.resources, 80_000_000, data.length);
    if (['doc', 'dot', 'odt', 'ott', 'hwp', 'hwpx'].includes(extension)) {
      const { importWordDocument } = await import('../docs/engine');
      const converted = await importWordDocument(bytes, extension);
      const document = await documents.import(name.slice(0, -(extension.length + 1)) + '.docx', 'docx', converted.bytes, undefined, undefined, tool.signal);
      return result(`Imported ${document.name}.`, { document, detail: converted.detail });
    }
    if (['xlsm', 'xls', 'tsv', 'ods', 'ots'].includes(extension)) {
      const { importWorkbook } = await import('../sheets/engine');
      const converted = await importWorkbook(bytes, extension);
      const convertedName = extension === 'xlsm' ? name : name.slice(0, -(extension.length + 1)) + '.xlsx';
      const document = await documents.import(convertedName, 'xlsx', converted.bytes, undefined, undefined, tool.signal);
      return result(`Imported ${document.name}.`, { document, detail: converted.detail });
    }
    if (extension === 'ppt' || extension === 'odp' || extension === 'otp') {
      const { importPresentation } = await import('../slides/engine');
      const converted = await importPresentation(bytes, extension);
      const document = await documents.import(name.slice(0, -(extension.length + 1)) + '.pptx', 'pptx', converted.bytes, undefined, undefined, tool.signal);
      return result(`Imported ${document.name}.`, { document, detail: converted.detail });
    }
    if (!type) invalid('Unsupported file type. Import .docx, .xlsx, .csv, .pptx, .ppt, .odp, .otp, .pdf, .md, .html, .txt or .json.');
    const document = await documents.import(name, type, bytes, resources, undefined, tool.signal);
    return result(`Imported ${document.name}.`, { document });
  });

  register('document_write', async (input, tool) => {
    const raw = object(input, ['documentId', 'expectedRevision', 'data', 'resources']);
    const id = documentId(raw.documentId);
    const expected = revision(raw.expectedRevision);
    const data = text(raw.data, 'data', 80_000_000);
    const bytes = decodeBase64(data);
    const resources = resourcesInput(raw.resources, 80_000_000, data.length);
    const document = await documents.write(id, expected, bytes, resources, tool.signal);
    return result(`Saved ${document.name}, revision ${document.revision}.`, { document });
  });

  register('document_read', async (input) => {
    const raw = object(input, ['documentId', 'full', 'sheet', 'range', 'password', 'from', 'to']);
    const id = documentId(raw.documentId);
    const full = optionalBoolean(raw.full, 'full') ?? true;
    const sheet = optionalText(raw.sheet, 'sheet', 100);
    const range = optionalText(raw.range, 'range', 50);
    const password = optionalText(raw.password, 'password', 1000);
    const from = raw.from === undefined ? undefined : integer(raw.from, 'from', 1);
    const to = raw.to === undefined ? undefined : integer(raw.to, 'to', from ?? 1);
    const { record, preview, resources } = await documents.preview(id, { full, sheet, range, password, from, to });
    return result(`${record.name}, revision ${record.revision}.`, { document: record, preview, ...(record.type === 'md' || record.type === 'html' ? { resources: resourcesOutput(resources) } : {}) });
  });

  register('document_edit', async (input) => {
    const raw = object(input, ['documentId', 'expectedRevision', 'ops', 'cells', 'source', 'pdf', 'resources']);
    const id = documentId(raw.documentId);
    const expected = revision(raw.expectedRevision);
    const resources = resourcesInput(raw.resources, 8_000_000, typeof raw.source === 'string' ? raw.source.length : 0);
    const { document, result: changed } = await documents.edit(id, expected, raw, resources);
    return result(`Saved ${document.name}, revision ${document.revision}.`, {
      document,
      summary: typeof changed.summary === 'string' ? changed.summary : '',
      detail: changed.detail ?? {},
      warnings: changed.warnings ?? []
    });
  });

  register('document_check', async (input) => {
    const raw = object(input, ['documentId', 'password']);
    const id = documentId(raw.documentId);
    const { record, check } = await documents.check(id, optionalText(raw.password, 'password', 1000));
    return result(typeof check.summary === 'string' ? check.summary : `Checked ${record.name}.`, {
      document: record,
      summary: typeof check.summary === 'string' ? check.summary : '',
      detail: check.detail ?? {},
      warnings: check.warnings ?? []
    });
  });

  register('document_export', async (input) => {
    const raw = object(input, ['documentId', 'format']);
    const id = documentId(raw.documentId);
    const format = raw.format === undefined ? 'original' : enumValue(raw.format, 'format', ['original', 'md', 'csv'] as const);
    const { record, exported, resources } = await documents.export(id, format);
    return result(`Exported ${exported.name}.`, {
      document: record,
      name: exported.name,
      mimeType: exported.mimeType,
      size: exported.bytes.byteLength,
      data: Buffer.from(exported.bytes).toString('base64'),
      ...(record.type === 'md' || record.type === 'html' ? { resources: resourcesOutput(resources) } : {})
    });
  });

  register('document_delete', async (input) => {
    const raw = object(input, ['documentId']);
    const id = documentId(raw.documentId);
    const record = await documents.remove(id);
    return result(`Deleted ${record.name}.`, { deleted: true, documentId: id });
  });

  register('document_guide', async (input) => {
    const raw = object(input, ['domain']);
    const domain = enumValue(raw.domain, 'domain', ['docs', 'sheets', 'slides'] as const);
    const output = await documents.guide(domain);
    return result(`GenOffice ${domain} guide.`, output);
  });

  register('document_convert', async (input, tool) => {
    const raw = object(input, ['documentId', 'to', 'name', 'password', 'sheet']);
    const id = documentId(raw.documentId);
    const to = enumValue(raw.to, 'to', ['docx', 'xlsx', 'csv', 'pptx', 'pdf', 'md', 'html'] as const);
    const output = await documents.convert(id, to, {
      name: optionalText(raw.name, 'name', 200),
      password: optionalText(raw.password, 'password', 1000),
      sheet: optionalText(raw.sheet, 'sheet', 100),
      signal: tool.signal
    });
    return result(`Converted ${output.source.name} to ${output.document.name}.`, output);
  });

  register('document_render', async (input, tool) => {
    const raw = object(input, ['documentId', 'scale', 'page', 'password']);
    const id = documentId(raw.documentId);
    const scale = raw.scale === undefined ? 1 : raw.scale;
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0 || scale > 4) invalid('scale must be greater than zero and at most four.');
    const output = await documents.render(id, {
      scale,
      page: raw.page === undefined ? undefined : integer(raw.page, 'page', 1),
      password: optionalText(raw.password, 'password', 1000),
      signal: tool.signal
    });
    return result(`Rendered ${output.images.length} page(s).`, output);
  });

  return tools;
}
