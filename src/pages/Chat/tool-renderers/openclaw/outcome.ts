import type { SessionRenderToolCard } from '../../../../types/session/tool-card';
import { parseToolResultJson } from '../result-content';
import { asRecord } from './text';

const MAX_RESULT_PARSE_CHARS = 20_000;

function readExitCode(value: unknown): number | undefined {
  const record = asRecord(value);
  const raw = record?.exitCode ?? record?.code;
  const code = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : undefined;
  return code !== undefined && Number.isFinite(code) ? code : undefined;
}

export function readOpenClawExitCode(tool: SessionRenderToolCard): number | undefined {
  const direct = readExitCode(tool.details) ?? readExitCode(tool.output);
  if (direct !== undefined) return direct;
  const result = tool.result;
  if ((result.kind !== 'text' && result.kind !== 'json') || result.bodyText.length > MAX_RESULT_PARSE_CHARS) return undefined;
  return readExitCode(parseToolResultJson(result.bodyText));
}

export function resolveOpenClawToolStatus(tool: SessionRenderToolCard): SessionRenderToolCard['status'] {
  if (tool.status !== 'completed') return tool.status;
  const exitCode = readOpenClawExitCode(tool);
  return exitCode !== undefined && exitCode !== 0 ? 'error' : tool.status;
}
