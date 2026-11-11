import type { AppToolHandler } from '@matcha/app-plugins-sdk';
import type { DocumentService } from '../documents/service';
import { errorMessage } from '../errors';
import type { createSlidesSession } from './session';
import Ajv from 'ajv';
import { slidesActionSchema } from './actions-schema';

const ajv = new Ajv({ strict: true });
const validateAction = ajv.compile(slidesActionSchema);

export function createSlidesTools(
  documents: DocumentService,
  slides: ReturnType<typeof createSlidesSession>
): Record<string, AppToolHandler> {
  return {
    document_slides_action: async (input, tool) => {
      try {
        if (!validateAction(input)) throw new Error(`Invalid Slides action: ${ajv.errorsText(validateAction.errors)}`);
        const response = await slides.action(input.documentId as string, input.action as string, input.input as Record<string, unknown>, tool.signal) as { result?: { output?: string; isError?: boolean } };
        return { content: [{ type: 'text', text: response.result?.output ?? 'ok' }], ...(response.result?.isError ? { isError: true } : {}), structuredContent: { result: response } };
      } catch (error) {
        const message = errorMessage(error);
        return { content: [{ type: 'text', text: message }], isError: true, structuredContent: { code: 'slides_action_failed', error: message } };
      }
    },
    office_slides_ipc: async (input) => {
      try {
        const output = await slides.call(input);
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { result: output } };
      } catch (error) {
        const message = errorMessage(error);
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          structuredContent: { code: 'slides_ipc_failed', error: message }
        };
      }
    },
    office_slides_open: async (input) => {
      try {
        const documentId = typeof input.documentId === 'string' ? input.documentId : '';
        if (!/^doc_[a-f0-9]{16}$/.test(documentId)) throw new Error('A library document id is required.');
        const { record, bytes } = await documents.read(documentId);
        if (record.type !== 'pptx') throw new Error('The library document is not a presentation.');
        const presentation = await slides.open(documentId, record.name, bytes, record.revision, typeof input.editorId === 'string' ? input.editorId : undefined);
        return { content: [{ type: 'text', text: 'opened' }], structuredContent: { presentation } };
      } catch (error) {
        const message = errorMessage(error);
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
          structuredContent: { code: 'slides_open_failed', error: message }
        };
      }
    }
  };
}
