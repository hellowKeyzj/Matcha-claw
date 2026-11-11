import type { AppToolHandler } from '@matcha/app-plugins-sdk';
import type { DocumentService } from '../documents/service';
import { OfficeError, errorMessage } from '../errors';
import type { createHtmlSession } from './session';

export function createHtmlTools(_documents: DocumentService, html: ReturnType<typeof createHtmlSession>): Record<string, AppToolHandler> {
  const fail = (error: unknown) => ({
    content: [{ type: 'text' as const, text: errorMessage(error) }], isError: true,
    structuredContent: { code: error instanceof OfficeError ? error.code : 'html_ipc_failed',
      error: errorMessage(error), ...(error instanceof OfficeError ? error.detail : {}) }
  });
  return {
    document_html_action: async (input, tool) => {
      try {
        if (typeof input.documentId !== 'string' || !/^doc_[a-f0-9]{16}$/.test(input.documentId) || typeof input.action !== 'string' || (input.input !== undefined && (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)))) throw new OfficeError('invalid_input', 'A document id and HTML action input are required.');
        const result = await html.action(input.documentId, input.action, input.input as Record<string, unknown> | undefined, tool.signal) as { output?: string; isError?: boolean };
        return { content: [{ type: 'text', text: result.output ?? JSON.stringify(result) }], ...(result.isError ? { isError: true } : {}), structuredContent: { result } };
      } catch (error) { return fail(error); }
    },
    office_html_ipc: async (input, tool) => {
      try { return { content: [{ type: 'text', text: 'ok' }], structuredContent: { result: await html.call(input, tool.signal) } }; }
      catch (error) { return fail(error); }
    },
    office_html_open: async (input) => {
      try {
        if (typeof input.documentId !== 'string' || !/^doc_[a-f0-9]{16}$/.test(input.documentId)) throw new OfficeError('invalid_input', 'A library document id is required.');
        const document = await html.open(input.documentId, undefined, undefined, undefined, typeof input.editorId === 'string' ? input.editorId : undefined);
        return { content: [{ type: 'text', text: 'opened' }], structuredContent: { document } };
      } catch (error) { return fail(error); }
    }
  };
}
