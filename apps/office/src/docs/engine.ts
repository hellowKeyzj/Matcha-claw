import type {
  ApplyOptions,
  DocOpsOutcome,
  ExportHtml,
  OpenDocument
} from '../../genoffice/packages/cli/src/formats/docx';

import type { DocsReadProjection } from './projection';
export type { DocsReadProjection } from './projection';

type DocxModule = typeof import('../../genoffice/packages/cli/src/formats/docx');

let loaded: Promise<DocxModule> | undefined;

/**
 * The docs engine is a ProseMirror document: it needs a DOM before the editor
 * modules are imported. GenOffice ships that bootstrap in dom.ts and the plugin
 * backend runs in its own process, so installing the globals here is contained.
 */
async function load(): Promise<DocxModule> {
  loaded ??= (async () => {
    const { ensureDom } = await import('../platform/replacements/dom');
    await ensureDom();
    return import('../../genoffice/packages/cli/src/formats/docx');
  })();
  return loaded;
}

export async function createDocxFromMarkdown(markdown: string): Promise<Uint8Array> {
  const { marked } = await import('marked');
  const html = String(await marked.parse(markdown, { async: false }));
  return createDocxFromHtml(html);
}

export async function createDocxFromHtml(html: string): Promise<Uint8Array> {
  const docx = await load();
  const document = await docx.blankDocument();
  try {
    docx.fillFromHtml(document, html);
    return await docx.saveDocument(document);
  } finally {
    docx.closeDocument(document);
  }
}

async function docxInput(bytes: Uint8Array, password?: string): Promise<Uint8Array> {
  const { decryptDocx, isEncryptedDocx } = await import('../../genoffice/apps/docs/src/main/docx-encryption');
  if (!isEncryptedDocx(Buffer.from(bytes))) return bytes;
  if (!password) throw new Error('A password is required to read this Word document.');
  return decryptDocx(Buffer.from(bytes), password);
}

export async function readDocx(bytes: Uint8Array, full: boolean, password?: string): Promise<DocsReadProjection & {
  html: string;
  blocks: number;
  items: readonly unknown[];
  truncated: boolean;
}> {
  const docx = await load();
  const document = await docx.openDocument(await docxInput(bytes, password));
  try {
    const exported: ExportHtml = docx.documentHtml(document);
    const blocks = docx.describeDocument(document, undefined, full ? 1_000_000 : 2_000);
    const maximum = 400_000;
    const html = full ? exported.html : exported.html.slice(0, maximum);
    return {
      properties: docx.listProperties(document),
      notes: docx.listNotes(document),
      fields: docx.listFields(document),
      styles: docx.listStyles(document),
      tableStyles: docx.listTableStyles(document),
      comments: docx.listComments(document),
      revisions: docx.listRevisions(document),
      headerFooter: docx.headerFooterState(document),
      html,
      blocks: blocks.length,
      items: blocks,
      truncated: !full && exported.html.length > maximum
    };
  } finally {
    docx.closeDocument(document);
  }
}

export async function applyDocxOps(
  bytes: Uint8Array,
  ops: readonly unknown[],
  options: ApplyOptions = {}
): Promise<{ bytes: Uint8Array; outcome: DocOpsOutcome }> {
  const docx = await load();
  const document = await docx.openDocument(bytes);
  try {
    const outcome = await docx.applyDocOps(document, ops as Record<string, unknown>[], options);
    if (outcome.failures.length) return { bytes, outcome };
    return { bytes: await docx.saveDocument(document), outcome };
  } finally {
    docx.closeDocument(document);
  }
}

export async function checkDocx(bytes: Uint8Array, password?: string): Promise<readonly unknown[]> {
  const docx = await load();
  const check = await import('../../genoffice/packages/cli/src/formats/docx-check');
  const document = await docx.openDocument(await docxInput(bytes, password));
  try {
    return check.checkDocument(document);
  } finally {
    docx.closeDocument(document);
  }
}

export async function importWordDocument(bytes: Uint8Array, extension: string): Promise<{ bytes: Uint8Array; detail: string[] }> {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (ext === 'docx') return { bytes, detail: [] };
  if (ext === 'doc' || ext === 'dot') {
    const { convertLegacyDocToDocx } = await import('../../genoffice/packages/doc2docx/src');
    const result = await convertLegacyDocToDocx(bytes);
    return { bytes: result.docx, detail: result.warnings };
  }
  const result = ext === 'odt' || ext === 'ott'
    ? await (await import('../../genoffice/packages/odf2ooxml/src')).convertOdtToDocx(bytes)
    : ext === 'hwp' || ext === 'hwpx'
      ? await (await import('../../genoffice/packages/hwp2docx/src')).convertHwpToDocx(bytes)
      : null;
  if (!result) throw new Error('Unsupported Word import format.');
  return { bytes: result.docx, detail: result.dropped.map(item => `${item.what}: ${item.count}`) };
}

export async function docxToMarkdown(bytes: Uint8Array): Promise<string> {
  const docx = await load();
  const document = await docx.openDocument(bytes);
  try {
    const { documentToMarkdown } = await import('../../genoffice/apps/docs/src/renderer/export-markdown');
    const { MARKDOWN_MEDIA_DIR_TOKEN } = await import('../../genoffice/apps/docs/src/shared/ipc');
    const exported = documentToMarkdown(document.editor);
    let markdown = exported.markdown;
    for (const image of exported.images) markdown = markdown.split(`${MARKDOWN_MEDIA_DIR_TOKEN}/${image.name}`).join(image.src);
    return markdown;
  } finally {
    docx.closeDocument(document);
  }
}

export async function docsGuide(): Promise<{ catalog: unknown; htmlRules: string; imageSources: string }> {
  const docx = await load();
  return {
    ...await docx.docsCatalog(),
    imageSources: 'Use uploaded image bytes as a data:image/png|jpeg|gif;base64 URL, or an HTTP(S) URL. Bare local paths are not authorized by document_edit; import the local image bytes first.'
  };
}

export type { OpenDocument };
