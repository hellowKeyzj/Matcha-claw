import type { AppToolHandler } from '@matcha/app-plugins-sdk';
import type { DocumentService } from '../documents/service';
import { OfficeError, errorMessage } from '../errors';
import { validateMarkdownAction } from './actions-schema';
import type { createMarkdownSession } from './session';

export function createMarkdownTools(_documents: DocumentService, session: ReturnType<typeof createMarkdownSession>): Record<string, AppToolHandler> {
  const failure = (error: unknown) => ({
    content: [{ type: 'text' as const, text: errorMessage(error) }],
    isError: true,
    structuredContent: { code: error instanceof OfficeError ? error.code : 'markdown_failed', error: errorMessage(error) }
  });
  return {
    document_markdown_action: async (input, tool) => {
      try {
        validateMarkdownAction(input);
        const result = await session.action(input.documentId, input.action, input.input, tool.signal);
        const execution = result && typeof result === 'object' ? result : {};
        const text = 'output' in execution && typeof execution.output === 'string' ? execution.output : JSON.stringify(result);
        const isError = 'isError' in execution && execution.isError === true;
        return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}), structuredContent: { result } };
      } catch (error) { return failure(error); }
    },
    office_markdown_ipc: async (input) => {
      try {
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { result: await session.call(input) } };
      } catch (error) { return failure(error); }
    },
    office_markdown_open: async (input) => {
      try {
        if (typeof input.documentId !== 'string' || !/^doc_[a-f0-9]{16}$/.test(input.documentId)) throw new Error('A library document id is required.');
        const document = await session.open(input.documentId, typeof input.editorId === 'string' ? input.editorId : undefined);
        return { content: [{ type: 'text', text: 'opened' }], structuredContent: { document } };
      } catch (error) { return failure(error); }
    }
  };
}
