import type {
  SessionRenderToolCard,
  SessionRenderToolResult,
} from '../../../shared/session-adapter-types';
import { resolveToolDisplaySummary } from './tool-display';
import { normalizeOptionalString } from './tool-card-utils';
import {
  buildCanvasPreviewSummary,
  buildSemanticTextPreview,
  buildToolResultPreviewText,
  detectJsonText,
  extractCanvasToolPreview,
  serializeToolPayload,
} from './tool-card-preview';

export function resolveToolCardRenderState(input: {
  name: string;
  input: unknown;
  output?: unknown;
  outputText?: string;
}): Pick<SessionRenderToolCard, 'displayTitle' | 'displayDetail' | 'inputText' | 'result'> {
  const display = resolveToolDisplaySummary({
    name: input.name,
    args: input.input,
  });
  const inputText = serializeToolPayload(input.input);
  const fallbackDisplayDetail = !display.detail && inputText
    ? buildSemanticTextPreview(inputText)
    : undefined;
  const normalizedOutputText = normalizeOptionalString(input.outputText)
    ?? serializeToolPayload(input.output);
  const preview = extractCanvasToolPreview(input.output ?? normalizedOutputText, input.name);
  const jsonOutput = preview ? null : detectJsonText(normalizedOutputText);
  const collapsedPreview = normalizedOutputText
    ? buildToolResultPreviewText(normalizedOutputText)
    : '';
  const result: SessionRenderToolResult = preview
    ? {
        kind: 'canvas',
        surface: 'assistant-bubble',
        collapsedPreview: buildCanvasPreviewSummary(preview),
        preview,
        ...(normalizedOutputText ? { rawText: normalizedOutputText } : {}),
      }
    : jsonOutput
      ? {
          kind: 'json',
          surface: 'tool-card',
          collapsedPreview: jsonOutput.summary,
          bodyText: jsonOutput.pretty,
        }
      : normalizedOutputText
        ? {
            kind: 'text',
            surface: 'tool-card',
            collapsedPreview,
            bodyText: normalizedOutputText,
          }
        : {
          kind: 'none',
          surface: 'tool-card',
        };

  return {
    displayTitle: display.title,
    ...((display.detail ?? fallbackDisplayDetail) ? { displayDetail: display.detail ?? fallbackDisplayDetail } : {}),
    ...(inputText ? { inputText } : {}),
    result,
  };
}

export function serializeToolResultBodyText(result: SessionRenderToolResult): string | undefined {
  if (result.kind === 'none' || result.kind === 'canvas') {
    return undefined;
  }
  return result.bodyText;
}
