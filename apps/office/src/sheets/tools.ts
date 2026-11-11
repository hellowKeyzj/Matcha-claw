import type { AppToolHandler } from '@matcha/app-plugins-sdk';
import type { DocumentService } from '../documents/service';
import { OfficeError, errorMessage } from '../errors';
import Ajv from 'ajv';
import { sheetsActions } from './actions-schema';
const ajv = new Ajv({ strict: true });
const actionValidators = new Map(sheetsActions.map(action => [action.name, ajv.compile(action.inputSchema)]));
import type { createSheetsSession } from './session';

export function createSheetsTools(
  documents: DocumentService,
  sheets: ReturnType<typeof createSheetsSession>
): Record<string, AppToolHandler> {
  return {
    document_sheets_action: async (input, tool) => {
      try {
        const { documentId, action, input: arguments_ } = input;
        if (typeof documentId !== 'string' || !/^doc_[a-f0-9]{16}$/.test(documentId)) throw new Error('A library document id is required.');
        if (typeof action !== 'string' || !sheetsActions.some(item => item.name === action) || !arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) throw new Error('A workbook action and input object are required.');
        const validate = actionValidators.get(action);
        if (!validate?.(arguments_)) throw new Error(`Invalid workbook action input: ${ajv.errorsText(validate?.errors)}`);
        const response = await sheets.action(documentId, action, arguments_ as Record<string, unknown>, tool.signal) as { result?: { output?: string; isError?: boolean } };
        return { content: [{ type: 'text', text: response.result?.output ?? 'ok' }], ...(response.result?.isError ? { isError: true } : {}), structuredContent: { result: response } };
      } catch (error) {
        const message = errorMessage(error);
        return { content: [{ type: 'text', text: message }], isError: true, structuredContent: { code: 'sheets_action_failed', error: message } };
      }
    },
    office_sheets_ipc: async (input) => {
      try {
        const output = await sheets.call(input);
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { result: output } };
      } catch (error) {
        const message = errorMessage(error);
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          structuredContent: {
            code: error instanceof OfficeError ? error.code : 'sheets_ipc_failed',
            error: message,
            ...(error instanceof OfficeError ? error.detail : undefined)
          }
        };
      }
    },
    office_sheets_open: async (input) => {
      try {
        const documentId = typeof input.documentId === 'string' ? input.documentId : '';
        if (!/^doc_[a-f0-9]{16}$/.test(documentId)) throw new Error('A library document id is required.');
        const { record, bytes, sourcePath } = await documents.read(documentId);
        if (record.type !== 'xlsx' && record.type !== 'csv') throw new Error('The library document is not a workbook.');
        const workbook = await sheets.open(documentId, record.name, bytes, record.revision, typeof input.editorId === 'string' ? input.editorId : undefined, sourcePath);
        return { content: [{ type: 'text', text: 'opened' }], structuredContent: { workbook } };
      } catch (error) {
        const message = errorMessage(error);
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          structuredContent: { code: 'sheets_open_failed', error: message }
        };
      }
    }
  };
}
