import { appToolName } from '@matcha/app-plugins-sdk';
import { validateSessionIdentity } from '@matcha/app-plugins-sdk';
import type { DesignComposeOperation } from '../compose-operation';
import { generationRequest, id, invalid, layerPatch, number, object, revision, text } from './validation';

type ComposeRequest = DesignComposeOperation['requests'][number];
type Attachment = NonNullable<DesignComposeOperation['references']>[number];
const attachmentFields = ['assetId', 'attachmentName', 'attachmentIndex', 'isPreview', 'originalMimeType'];

function attachment(value: unknown, source = false): Attachment {
  const raw = object(value, [...attachmentFields, ...(source ? ['layerId', 'name', 'crop'] : [])]);
  if (typeof raw.isPreview !== 'boolean') invalid('Invalid attachment isPreview.');
  const originalMimeType = text(raw.originalMimeType, 'originalMimeType', 100);
  if (!originalMimeType.startsWith('image/')) invalid('Compose attachments must reference images.');
  return { assetId: id(raw.assetId, 'assetId'), attachmentName: text(raw.attachmentName, 'attachmentName', 200),
    attachmentIndex: number(raw.attachmentIndex, 'attachmentIndex', 0, 15, true), isPreview: raw.isPreview, originalMimeType };
}

function contextName(operation: DesignComposeOperation, count: number): string {
  return operation.summary.imageCountNames[count];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function hasRequiredSources(request: ComposeRequest): boolean {
  return request.action === 'image' || request.action === 'video' || request.action === 'storyboard'
    || (request.sourceLayerIds?.length ?? 0) > 0;
}

function composeRequest(value: unknown): ComposeRequest {
  return generationRequest(value, 'draft');
}

function parseOperation(value: string): DesignComposeOperation {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { invalid('Invalid compose operation JSON.'); }
  const raw = object(parsed, ['toolName', 'document', 'summary', 'sources', 'references', 'model', 'logo', 'annotation', 'requests']);
  if (raw.toolName !== appToolName('matcha.design', 'generate')) invalid('Invalid compose generation tool.');
  const document = object(raw.document, ['id', 'revision', 'sessionIdentity']);
  if (document.sessionIdentity !== undefined) {
    const error = validateSessionIdentity(document.sessionIdentity);
    if (error) invalid(error);
  }
  const summary = object(raw.summary, ['name', 'imageCountNames']);
  if (!Array.isArray(summary.imageCountNames) || !summary.imageCountNames.length || summary.imageCountNames.length > 17) invalid('Invalid imageCountNames.');
  const imageCountNames = summary.imageCountNames.map((value) => text(value, 'image count name', 120));
  if (!Array.isArray(raw.sources) || raw.sources.length > 16) invalid('Invalid compose sources.');
  const sources = raw.sources.map((value): DesignComposeOperation['sources'][number] => {
    const checked = attachment(value, true);
    const source = value as Record<string, unknown>;
    return { ...checked, layerId: id(source.layerId, 'layerId'), name: text(source.name, 'source name', 200, true),
      ...(source.crop === undefined ? {} : { crop: layerPatch({ crop: source.crop }, 'image').crop }) };
  });
  let references: Attachment[] | undefined;
  if (raw.references !== undefined) {
    if (!Array.isArray(raw.references) || !raw.references.length || raw.references.length > 16) invalid('Invalid compose references.');
    references = raw.references.map((value) => attachment(value));
  }
  if (!Array.isArray(raw.requests) || !raw.requests.length || raw.requests.length > 16) invalid('Provide 1–16 compose requests.');
  const operation: DesignComposeOperation = {
    toolName: text(raw.toolName, 'toolName', 128),
    document: { id: id(document.id, 'document id'), revision: revision(document.revision),
      ...(document.sessionIdentity === undefined ? {} : { sessionIdentity: document.sessionIdentity as NonNullable<DesignComposeOperation['document']['sessionIdentity']> }) },
    summary: { name: text(summary.name, 'summary name', 120), imageCountNames }, sources,
    ...(references === undefined ? {} : { references }),
    ...(raw.model === undefined ? {} : { model: attachment(raw.model) }),
    ...(raw.logo === undefined ? {} : { logo: attachment(raw.logo) }),
    ...(raw.annotation === undefined ? {} : { annotation: attachment(raw.annotation) }),
    requests: raw.requests.map(composeRequest),
  };
  const metadata = [...sources, ...(references ?? []), ...[operation.model, operation.logo, operation.annotation].filter((entry): entry is Attachment => entry !== undefined)];
  if (metadata.length > 16 || new Set(metadata.map((entry) => entry.attachmentIndex)).size !== metadata.length
    || metadata.some((entry) => entry.attachmentIndex >= metadata.length)) invalid('Compose attachment indices must be complete and unique.');
  if (imageCountNames.length !== metadata.length + 1 || imageCountNames[0] !== operation.summary.name) invalid('Compose summary counts do not match its attachments.');
  const sourceIds = sources.map((entry) => entry.layerId);
  const referenceIds = (references ?? []).map((entry) => entry.assetId);
  if (new Set(sourceIds).size !== sourceIds.length || new Set(referenceIds).size !== referenceIds.length) invalid('Duplicate compose source or reference IDs.');
  const splitUpscale = operation.requests.length > 1;
  if (splitUpscale && (operation.requests.length !== sources.length
    || operation.requests.some((request) => request.action !== 'upscale'))) invalid('Only per-source upscale may contain multiple requests.');
  let upscaleParameters: string | undefined;
  for (const [index, request] of operation.requests.entries()) {
    if (request.documentId !== operation.document.id || !hasRequiredSources(request)
      || !sameIds(request.sourceLayerIds ?? [], splitUpscale ? [sourceIds[index]] : sourceIds)
      || !sameIds(request.referenceAssetIds ?? [], referenceIds)
      || request.modelAssetId !== operation.model?.assetId || request.logoAssetId !== operation.logo?.assetId
      || request.annotationAssetId !== operation.annotation?.assetId) invalid('Compose request references do not match its metadata.');
    if (request.expectedSourceAssetId !== undefined && request.expectedSourceAssetId !== sources[0]?.assetId) invalid('Compose expected source asset does not match its metadata.');
    if (request.expectedSourceCrop !== undefined && JSON.stringify(request.expectedSourceCrop) !== JSON.stringify(sources[0]?.crop ?? null)) invalid('Compose expected source crop does not match its metadata.');
    if (splitUpscale) {
      const { sourceLayerIds: _sourceLayerIds, ...parameters } = request;
      const serialized = JSON.stringify(parameters);
      if (upscaleParameters !== undefined && serialized !== upscaleParameters) invalid('Per-source upscale parameters must match.');
      upscaleParameters = serialized;
    }
  }
  return operation;
}

export function editComposeOperation(input: unknown): { context: null | { name: string; text: string; attachmentIndices: number[] } } {
  const raw = object(input, ['context', 'attachmentIndex', 'remainingAttachmentIndices']);
  const context = object(raw.context, ['name', 'text']);
  const name = text(context.name, 'context name', 120);
  const serialized = text(context.text, 'context text', 32 * 1024);
  if (new TextEncoder().encode(serialized).byteLength > 32 * 1024) invalid('Compose context exceeds 32 KiB.');
  const operation = parseOperation(serialized);
  const attachmentCount = operation.sources.length + (operation.references?.length ?? 0)
    + Number(!!operation.model) + Number(!!operation.logo) + Number(!!operation.annotation);
  if (name !== contextName(operation, attachmentCount)) invalid('Compose context name does not match its summary.');
  const removed = number(raw.attachmentIndex, 'attachmentIndex', 0, attachmentCount - 1, true);
  if (!Array.isArray(raw.remainingAttachmentIndices) || raw.remainingAttachmentIndices.length !== attachmentCount - 1) invalid('Invalid remainingAttachmentIndices.');
  const remaining = raw.remainingAttachmentIndices.map((entry) => number(entry, 'remainingAttachmentIndices', 0, attachmentCount - 1, true));
  if (remaining.some((entry, index) => entry !== (index < removed ? index : index + 1))) invalid('Remaining attachments must preserve every index except the removed attachment.');
  if (operation.logo?.attachmentIndex === removed || (operation.annotation
    && (operation.annotation.attachmentIndex === removed || operation.sources[0].attachmentIndex === removed))) return { context: null };

  const reindex = <T extends Attachment>(entry: T): T => ({ ...entry, attachmentIndex: remaining.indexOf(entry.attachmentIndex) });
  const sources = operation.sources.filter((entry) => entry.attachmentIndex !== removed).map(reindex);
  const references = (operation.references ?? []).filter((entry) => entry.attachmentIndex !== removed).map(reindex);
  const sourceIds = new Set(sources.map((entry) => entry.layerId));
  const referenceIds = new Set(references.map((entry) => entry.assetId));
  const removeModel = operation.model?.attachmentIndex === removed;
  const requests: ComposeRequest[] = [];
  for (const request of operation.requests) {
    let updated = request;
    if (removeModel) {
      const { modelAssetId: _modelAssetId, ...withoutModel } = request;
      updated = withoutModel;
    }
    updated = { ...updated,
      ...(request.sourceLayerIds === undefined ? {} : { sourceLayerIds: request.sourceLayerIds.filter((entry) => sourceIds.has(entry)) }),
      ...(request.referenceAssetIds === undefined ? {} : { referenceAssetIds: request.referenceAssetIds.filter((entry) => referenceIds.has(entry)) }) };
    if (!hasRequiredSources(updated)) {
      if (operation.requests.length > 1 && request.action === 'upscale') continue;
      return { context: null };
    }
    requests.push(composeRequest(updated));
  }
  if (!requests.length) return { context: null };
  const { sources: _sources, references: _references, model, ...unchanged } = operation;
  const updated: DesignComposeOperation = { ...unchanged, sources,
    summary: { ...operation.summary, imageCountNames: operation.summary.imageCountNames.slice(0, remaining.length + 1) },
    ...(references.length ? { references } : {}), ...(model && !removeModel ? { model: reindex(model) } : {}),
    ...(operation.logo ? { logo: reindex(operation.logo) } : {}),
    ...(operation.annotation ? { annotation: reindex(operation.annotation) } : {}), requests };
  const output = JSON.stringify(updated, null, 2);
  if (new TextEncoder().encode(output).byteLength > 32 * 1024) invalid('Compose context exceeds 32 KiB.');
  return { context: { name: contextName(updated, remaining.length), text: output, attachmentIndices: remaining } };
}
