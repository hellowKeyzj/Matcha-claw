// Adapted from OpenClaw tool-call rows and expanded tool content.
// Copyright (c) 2026 OpenClaw Foundation. SPDX-License-Identifier: MIT.
// See LICENSE and NOTICE in this directory.

import type { TFunction } from 'i18next';
import type { SessionRenderToolCard } from '../../../../types/session/tool-card';
import type { ToolActivityContent, ToolActivityDiffStat } from '../../tool-activity-view-model';
import type { ToolActivityDescriptor } from '../types';
import { extractToolResultContentBlockText, parseToolResultJson } from '../result-content';
import {
  distinctCollapsedSummary,
  formatCollapsedPreview,
  resolveCollapsedArgumentPreview,
  resolveToolDisplay,
} from './display';
import type { DiffLine } from './diff';
import { resolveExecCommandPreview } from './exec';
import { readOpenClawExitCode } from './outcome';
import { redactToolPayloadText } from './redact';
import { asRecord, readNonBlankString, sliceUtf16Safe } from './text';
import { resolvePathArg, resolveToolCallView, type ToolCallView } from './view';

function describeView(tool: SessionRenderToolCard, view: ToolCallView, t: TFunction<'chat'>): ToolActivityDescriptor {
  const display = resolveToolDisplay(tool.name, tool.input, view.kind === 'generic');
  const path = resolvePathArg(asRecord(tool.input));
  const fileOperations: ToolActivityDescriptor['fileOperations'] = view.fileOperations?.map(({ operation, path }) => ({
    kind: operation === 'add' ? 'write' : operation === 'delete' ? 'delete' : 'edit',
    path,
  }));
  const target = fileOperations ? view.target : view.kind === 'read' || view.kind === 'edit' || view.kind === 'write' ? path : view.target;
  const base = { kind: view.kind, label: display.label, ...(target ? { target } : {}), ...(fileOperations ? { fileOperations } : {}) };
  if (view.title) return { ...base, title: view.title };
  if (view.kind === 'command') {
    if (view.command) return { ...base, title: `$ ${resolveExecCommandPreview(view.command)}` };
    if (view.code) return { ...base, title: t('toolActivity.run', { name: asRecord(tool.input)?.language === 'typescript' ? 'TypeScript' : 'JavaScript' }) };
  }
  if (view.target) {
    switch (view.kind) {
      case 'read': return { ...base, title: t('toolActivity.search.read', { name: view.target }) };
      case 'edit': return { ...base, title: t('toolActivity.file.update', { name: view.target }) };
      case 'write': return { ...base, title: t('toolActivity.file.write', { name: view.target }) };
      case 'search': return { ...base, title: t('toolActivity.search.search', { query: view.target }) };
      case 'fetch': return { ...base, title: t('toolActivity.web.open', { name: view.target }) };
    }
  }
  const preview = (tool.name.trim().toLowerCase() === 'progress_card' || tool.name.trim().toLowerCase() === 'update_plan' ? undefined : resolveCollapsedArgumentPreview(tool.input))
    ?? display.detail
    ?? (typeof tool.input === 'string' ? formatCollapsedPreview(redactToolPayloadText(tool.inputText?.trim() ? tool.inputText : tool.input)) : undefined);
  const detail = distinctCollapsedSummary(preview, display.label);
  return { ...base, title: detail ? `${display.label} · ${detail}` : display.label };
}

/** Collapsed rows never compute local diffs or materialize result payloads. */
export function describeOpenClawToolActivity(tool: SessionRenderToolCard, t: TFunction<'chat'>): ToolActivityDescriptor {
  return describeView(tool, resolveToolCallView({ name: tool.name, args: tool.input, details: tool.details }, false), t);
}

function serializePayload(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    return Object.prototype.toString.call(value);
  }
}

function readResultText(tool: SessionRenderToolCard, resultValue: unknown): string | undefined {
  const output = extractToolResultContentBlockText(tool.output) ?? serializePayload(tool.output);
  if (output?.trim()) return output;
  const result = tool.result;
  const text = result.kind === 'text' || result.kind === 'json' ? result.bodyText : result.kind === 'canvas' ? result.rawText : undefined;
  return text?.trim() ? extractToolResultContentBlockText(resultValue) ?? text : undefined;
}

const ROW_SUMMARIZED_ARG_KEYS: Partial<Record<ToolCallView['kind'], ReadonlySet<string>>> = {
  read: new Set(['path', 'file_path', 'filePath', 'notebook_path']),
  search: new Set(['pattern', 'query', 'glob', 'path']),
  fetch: new Set(['url']),
};
const FILE_CHANGE_ARG_KEYS = new Set([
  'path', 'file_path', 'filePath', 'file', 'filepath', 'filename', 'notebook_path',
  'oldText', 'old_string', 'oldString', 'old_str', 'newText', 'new_string', 'newString', 'new_str', 'edits',
  'content', 'file_text', 'insert_text', 'patch', 'input', 'diff', 'changes',
]);

function formatKeyValue(value: unknown): string {
  if (typeof value === 'string') return sliceUtf16Safe(value, 0, 400);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return sliceUtf16Safe(JSON.stringify(value) ?? String(value), 0, 400);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function appendParameters(
  tool: SessionRenderToolCard,
  args: unknown,
  blocks: ToolActivityContent['textBlocks'],
  t: TFunction<'chat'>,
): ToolActivityContent['parameters'] {
  const record = asRecord(args);
  if (record) {
    const entries = Object.entries(record);
    if (entries.length === 0) return undefined;
    if (entries.length <= 12) return entries.map(([name, value]) => ({ name, value: formatKeyValue(value) }));
  }
  const text = record ? serializePayload(args) : readNonBlankString(tool.inputText) ?? serializePayload(args);
  if (text?.trim()) blocks.push({ kind: 'input', title: t('toolActivity.input'), text, copyable: true, ...(record || Array.isArray(args) ? { format: 'json' as const } : {}) });
  return undefined;
}

function serializeDiff(lines: readonly DiffLine[]): string {
  return lines.map((line) => {
    if (line.kind === 'skip') return ' …';
    if (line.kind === 'file') return ` ${line.text}`;
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    return `${sign}${line.lineNo === undefined ? '' : `${line.lineNo} `}${line.text}`;
  }).join('\n');
}

function buildDiffStat(view: ToolCallView, tool: SessionRenderToolCard): ToolActivityDiffStat | undefined {
  if (!view.stat) return undefined;
  const paths = view.fileOperations?.map(({ path }) => path) ?? [resolvePathArg(asRecord(tool.input))].filter((path): path is string => !!path);
  const filesChanged = [...new Set(paths)];
  const filesCreated = view.fileOperations?.filter(({ operation }) => operation === 'add').map(({ path }) => path)
    ?? (view.kind === 'write' && asRecord(tool.details)?.created === true ? filesChanged : undefined);
  return {
    additions: view.stat.added,
    deletions: view.stat.removed,
    ...(filesChanged.length > 0 ? { filesChanged, fileCount: filesChanged.length } : {}),
    ...(filesCreated?.length ? { filesCreated: [...new Set(filesCreated)] } : {}),
  };
}

/** Called only after disclosure; public payloads remain text, never executable HTML. */
export function buildOpenClawToolActivityContent(tool: SessionRenderToolCard, t: TFunction<'chat'>): ToolActivityContent {
  const result = tool.result;
  const resultText = result.kind === 'text' || result.kind === 'json' ? result.bodyText : result.kind === 'canvas' ? result.rawText : undefined;
  const outputValue = tool.output === null || tool.output === undefined || (typeof tool.output === 'string' && !tool.output.trim())
    ? parseToolResultJson(resultText)
    : tool.output;
  const view = resolveToolCallView({ name: tool.name, args: tool.input, details: tool.details, result: outputValue });
  const descriptor = describeView(tool, view, t);
  const textBlocks: ToolActivityContent['textBlocks'] = [];
  const trailingLabels: ToolActivityContent['trailingLabels'] = [];
  const exitCode = readOpenClawExitCode(tool);
  const hasOutputError = exitCode !== undefined && exitCode !== 0;
  const succeeded = tool.status === 'completed' && !hasOutputError;
  let parameters: ToolActivityContent['parameters'];

  if (view.kind === 'command' && (view.command || view.code)) {
    const sourceKey = view.code ? 'code' : 'command';
    const source = readNonBlankString(asRecord(tool.input)?.[sourceKey]) ?? view.code ?? view.command!;
    textBlocks.push({ kind: 'input', title: t('toolActivity.input'), text: source, copyable: true, ...(view.code ? {} : { format: 'command' as const }) });
    const extraArgs = Object.fromEntries(Object.entries(asRecord(tool.input) ?? {}).filter(([key]) => key !== sourceKey));
    parameters = appendParameters(tool, extraArgs, textBlocks, t);
  } else if ((view.kind === 'edit' || view.kind === 'write') && view.diff?.length) {
    const operations = view.fileOperations;
    const path = resolvePathArg(asRecord(tool.input));
    const files = operations?.map(({ operation, path, oldPath }) => `${operation} ${oldPath ? `${oldPath} → ` : ''}${path}`).join('\n') ?? path;
    if (files) textBlocks.push({ kind: 'input', title: t('toolActivity.path'), text: files, copyable: true });
    textBlocks.push({ kind: 'output', title: t(succeeded ? 'toolActivity.file.diff' : 'toolActivity.file.attemptedChanges'), text: serializeDiff(view.diff), copyable: true, format: 'diff' });
    const extraArgs = Object.fromEntries(Object.entries(asRecord(tool.input) ?? {}).filter(([key]) => !FILE_CHANGE_ARG_KEYS.has(key)));
    parameters = appendParameters(tool, extraArgs, textBlocks, t);
  } else {
    const args = asRecord(tool.input);
    if (view.kind === 'read' || ((view.kind === 'edit' || view.kind === 'write') && view.content !== undefined)) {
      const path = resolvePathArg(args);
      if (path) textBlocks.push({ kind: 'input', title: t('toolActivity.path'), text: path, copyable: true });
    } else if (view.kind === 'search') {
      const target = [view.target, view.targetDetail].filter(Boolean).join('\n');
      if (target) textBlocks.push({ kind: 'input', title: t('toolActivity.target'), text: target, copyable: true });
    } else if (view.kind === 'fetch' && view.target) {
      textBlocks.push({ kind: 'input', title: t('toolActivity.target'), text: view.target, copyable: true });
    }
    const summarized = (view.kind === 'edit' || view.kind === 'write') && view.content !== undefined ? FILE_CHANGE_ARG_KEYS : ROW_SUMMARIZED_ARG_KEYS[view.kind];
    const inputArgs = args && summarized ? Object.fromEntries(Object.entries(args).filter(([key]) => !summarized.has(key))) : tool.input;
    parameters = appendParameters(tool, inputArgs, textBlocks, t);
  }

  if (view.content !== undefined) textBlocks.push({ kind: 'output', title: t(view.kind === 'edit' ? 'toolActivity.file.updatedContent' : 'toolActivity.content'), text: view.content, copyable: true });
  const output = view.resultHandled ? serializePayload(view.resultRemainder) : readResultText(tool, outputValue);
  if (output?.trim()) textBlocks.push({ kind: 'output', title: t('toolActivity.output'), text: output, copyable: true });
  if (exitCode !== undefined) trailingLabels.push({ text: t('toolActivity.shell.exit', { code: exitCode }), tone: 'muted' });
  const diffStat = succeeded ? buildDiffStat(view, tool) : undefined;
  if (diffStat?.additions) trailingLabels.push({ text: `+${diffStat.additions}`, tone: 'neutral' });
  if (diffStat?.deletions) trailingLabels.push({ text: `-${diffStat.deletions}`, tone: 'neutral' });
  return {
    title: descriptor.title,
    canExpand: textBlocks.length > 0 || !!parameters?.length,
    trailingLabels,
    textBlocks,
    ...(parameters ? { parameters } : {}),
    ...(diffStat ? { diffStat, diffStatPlacement: 'header' as const } : {}),
    ...(hasOutputError ? { hasOutputError: true } : {}),
  };
}
