import type { SavePdfRequest } from '../../genoffice/apps/pdf/src/shared/ipc';
import { validateRedactionRegions } from '../../genoffice/apps/pdf/src/main/redaction';

export function validatePdfEdits(value: unknown): asserts value is Omit<SavePdfRequest, 'path' | 'targetPath'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PDF edits must be an object.');
  const request = value as Record<string, unknown>;
  for (const key of ['markups', 'drawings', 'formValues', 'stamps']) if (!Array.isArray(request[key])) throw new Error(`PDF edits require ${key}.`);
  for (const key of ['annotDeletes', 'noteEdits', 'textEdits', 'textInserts', 'imageEdits', 'redactions', 'staticFormFills', 'formWidgetEdits', 'formFields', 'blankPages', 'rotations', 'deletedPages', 'pageOrder', 'outline']) {
    if (request[key] !== undefined && !Array.isArray(request[key])) throw new Error(`Invalid PDF ${key}.`);
  }
  function inspect(entry: unknown): void {
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error('PDF edits contain a non-finite number.');
    if (Array.isArray(entry)) for (const child of entry) inspect(child);
    else if (entry && typeof entry === 'object') for (const child of Object.values(entry)) inspect(child);
  }
  inspect(value);
  if (request.redactions !== undefined) {
    validateRedactionRegions(request.redactions);
    for (const key of ['markups', 'annotDeletes', 'drawings', 'noteEdits', 'formValues', 'stamps', 'textEdits', 'textInserts', 'imageEdits', 'rotations', 'deletedPages', 'pageOrder']) {
      if ((request[key] as unknown[] | undefined)?.length) throw new Error('Save other pending edits before applying redactions.');
    }
    if (request.metadata) throw new Error('Save other pending edits before applying redactions.');
  }
}
