import type { AppToolHandler } from '@matcha/app-plugins-sdk';
import { OfficeError, errorMessage } from '../errors';
import type { createDocsSession } from './session';

export function createDocsTools(session: ReturnType<typeof createDocsSession>): Record<string, AppToolHandler> {
  return {
    office_docs_ipc: async (input, tool) => {
      try {
        tool.signal.throwIfAborted();
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { result: await session.call(input, tool.signal) } };
      } catch (error) {
        const message = errorMessage(error);
        return {
          content: [{ type: 'text', text: message }], isError: true,
          structuredContent: { code: error instanceof OfficeError ? error.code : 'docs_ipc_failed', error: message }
        };
      }
    }
  };
}
