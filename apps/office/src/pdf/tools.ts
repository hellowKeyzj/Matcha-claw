import type { AppToolHandler } from '@matcha/app-plugins-sdk';
import type { DocumentService } from '../documents/service';
import { errorMessage, OfficeError } from '../errors';
import type { createPdfSession } from './session';
import { encodePdfValue, decodePdfValue } from './wire';

export function createPdfTools(documents: DocumentService, session: ReturnType<typeof createPdfSession>): Record<string, AppToolHandler> {
  const wrap = (run: (input: Readonly<Record<string, unknown>>) => Promise<unknown>): AppToolHandler => async (input) => {
    try { return { content: [{ type: 'text', text: 'ok' }], structuredContent: { result: encodePdfValue(await run(decodePdfValue(input) as Readonly<Record<string, unknown>>)) } }; }
    catch (error) {
      const message = errorMessage(error);
      return { content: [{ type: 'text', text: message }], isError: true, structuredContent: { code: error instanceof OfficeError ? error.code : 'pdf_failed', error: message } };
    }
  };
  return {
    office_pdf_ipc: wrap((input) => session.call(input)),
    office_pdf_open: wrap(async (input) => {
      if (typeof input.documentId !== 'string' || !/^doc_[a-f0-9]{16}$/.test(input.documentId)) throw new Error('A library document id is required.');
      const { record, bytes } = await documents.read(input.documentId);
      if (record.type !== 'pdf') throw new Error('The selected document is not a PDF.');
      return session.open(record.id, record.name, bytes, record.revision, typeof input.editorId === 'string' ? input.editorId : undefined);
    })
  };
}
