// Adapted from OpenClaw tool-display-common, tool-display-exec and tool-cards.
// Copyright (c) 2026 OpenClaw Foundation. SPDX-License-Identifier: MIT.
// See LICENSE and NOTICE in this directory.

import config from './tool-display.json';
import { redactToolPayloadText } from './redact';
import { asRecord, sanitizeTerminalText, sliceUtf16Safe } from './text';

type DisplaySpec = {
  title?: string;
  label?: string;
  detailKeys?: readonly string[];
  actions?: Record<string, { label?: string; detailKeys?: readonly string[] }>;
};
const TOOL_MAP: Record<string, DisplaySpec> = config.tools;

function defaultTitle(name: string): string {
  const cleaned = name.replace(/_/g, ' ').trim();
  if (!cleaned) return 'Tool';
  return cleaned.split(/\s+/).map((part) =>
    part.length <= 2 && part.toUpperCase() === part ? part : `${part.at(0)?.toUpperCase() ?? ''}${part.slice(1)}`,
  ).join(' ');
}

function coerceDisplayValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const rawLine = value.trim().split(/\r?\n/)[0]?.trim();
    if (!rawLine) return undefined;
    const firstLine = redactToolPayloadText(rawLine);
    return firstLine.length > 160
      ? `${sliceUtf16Safe(firstLine, 0, 79)}…${sliceUtf16Safe(firstLine, -80)}`
      : firstLine;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (Array.isArray(value)) {
    const values: string[] = [];
    let count = 0;
    for (const item of value) {
      const display = coerceDisplayValue(item);
      if (!display) continue;
      count += 1;
      if (values.length < 3) values.push(display);
    }
    if (!count) return undefined;
    return `${values.join(', ')}${count > 3 ? '…' : ''}`;
  }
  return undefined;
}

function lookupValueByPath(args: unknown, path: string): unknown {
  let current = args;
  for (const segment of path.split('.')) {
    if (!segment || !current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function shortenHome(input: string): string {
  return input
    .replace(/^\/Users\/[^/]+(\/|$)/, '~$1')
    .replace(/^\/home\/[^/]+(\/|$)/, '~$1')
    .replace(/^C:\\Users\\[^\\]+(\\|$)/i, '~$1');
}

export function resolveToolDisplay(name: string, args: unknown, includeDetail = true): { label: string; verb?: string; detail?: string } {
  const normalizedName = (name ?? 'tool').trim();
  const key = normalizedName.toLowerCase();
  const spec = TOOL_MAP[key];
  const title = spec?.title ?? defaultTitle(normalizedName);
  const label = spec?.label ?? title;
  // Progress arguments belong to the existing safe receipt renderer.
  if (!includeDetail || key === 'progress_card' || key === 'update_plan') return { label };
  const actionValue = asRecord(args)?.action;
  const action = typeof actionValue === 'string' ? actionValue.trim() || undefined : undefined;
  const actionSpec = action ? spec?.actions?.[action] : undefined;
  const fallbackVerb = key === 'web_search' ? 'search' : key === 'web_fetch' ? 'fetch' : key.replace(/[_.]/g, ' ');
  const verb = (actionSpec?.label ?? action ?? fallbackVerb).trim().replace(/_/g, ' ') || undefined;
  const specialDetail = key === 'read' ? resolveReadDetail(args)
    : key === 'write' || key === 'edit' || key === 'attach' ? resolveWriteDetail(key, args)
    : key === 'web_search' ? resolveWebSearchDetail(args)
    : key === 'web_fetch' ? resolveWebFetchDetail(args)
    : undefined;
  if (specialDetail) return { label, verb, detail: shortenHome(redactToolPayloadText(specialDetail)) };
  const keys = actionSpec?.detailKeys ?? spec?.detailKeys ?? config.fallback.detailKeys;
  for (const path of keys) {
    const detail = coerceDisplayValue(lookupValueByPath(args, path));
    if (detail) return { label, verb, detail: shortenHome(detail) };
  }
  return { label, verb };
}

export function resolveExecTitle(args: unknown): string | undefined {
  const title = asRecord(args)?.title;
  if (typeof title !== 'string') return undefined;
  const text = sanitizeTerminalText(title.replace(/\s+/gu, ' ')).trim();
  return sliceUtf16Safe(redactToolPayloadText(text), 0, 120) || undefined;
}

function formatCollapsedSummary(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  return normalized.replace(/^with\s+/i, '').trim() || normalized;
}

export function formatCollapsedPreview(value: string | undefined): string | undefined {
  const normalized = formatCollapsedSummary(value);
  return normalized ? sliceUtf16Safe(normalized, 0, 120) : undefined;
}

export function distinctCollapsedSummary(value: string | undefined, label: string): string | undefined {
  const displayValue = formatCollapsedSummary(value);
  const valueKey = displayValue?.toLowerCase().replace(/[\s._-]+/g, '');
  const labelKey = formatCollapsedSummary(label)?.toLowerCase().replace(/[\s._-]+/g, '');
  return valueKey && labelKey && valueKey === labelKey ? undefined : displayValue;
}

const PREVIEW_KEYS = ['message', 'prompt', 'task', 'query', 'text', 'description'] as const;

export function resolveCollapsedArgumentPreview(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  for (const key of PREVIEW_KEYS) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const firstLine = value.split(/\r\n?|\n/).find((line) => line.trim().length > 0);
    const preview = formatCollapsedPreview(firstLine ? redactToolPayloadText(firstLine) : undefined);
    if (preview) return preview;
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function resolvePathArg(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  for (const candidate of [record.path, record.file_path, record.filePath]) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function resolveReadDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const path = resolvePathArg(record);
  if (!path) {
    return undefined;
  }

  const offsetRaw =
    typeof record.offset === "number" && Number.isFinite(record.offset)
      ? Math.floor(record.offset)
      : undefined;
  const limitRaw =
    typeof record.limit === "number" && Number.isFinite(record.limit)
      ? Math.floor(record.limit)
      : undefined;

  const offset = offsetRaw !== undefined ? Math.max(1, offsetRaw) : undefined;
  const limit = limitRaw !== undefined ? Math.max(1, limitRaw) : undefined;

  if (offset !== undefined && limit !== undefined) {
    const unit = limit === 1 ? "line" : "lines";
    return `${unit} ${offset}-${offset + limit - 1} from ${path}`;
  }
  if (offset !== undefined) {
    return `from line ${offset} in ${path}`;
  }
  if (limit !== undefined) {
    const unit = limit === 1 ? "line" : "lines";
    return `first ${limit} ${unit} of ${path}`;
  }
  return `from ${path}`;
}

function resolveWriteDetail(toolKey: string, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const path = resolvePathArg(record) ?? normalizeOptionalString(record.url);
  if (!path) {
    return undefined;
  }

  if (toolKey === "attach") {
    return `from ${path}`;
  }

  const destinationPrefix = toolKey === "edit" ? "in" : "to";
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.newText === "string"
        ? record.newText
        : typeof record.new_string === "string"
          ? record.new_string
          : undefined;

  if (content && content.length > 0) {
    return `${destinationPrefix} ${path} (${content.length} chars)`;
  }

  return `${destinationPrefix} ${path}`;
}

function resolveWebSearchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const queries = collectWebSearchQueries(record);
  const count =
    typeof record.count === "number" && Number.isFinite(record.count) && record.count > 0
      ? Math.floor(record.count)
      : typeof record.max_results === "number" &&
          Number.isFinite(record.max_results) &&
          record.max_results > 0
        ? Math.floor(record.max_results)
        : typeof record.num_results === "number" &&
            Number.isFinite(record.num_results) &&
            record.num_results > 0
          ? Math.floor(record.num_results)
          : typeof record.limit === "number" && Number.isFinite(record.limit) && record.limit > 0
            ? Math.floor(record.limit)
            : typeof record.top_k === "number" && Number.isFinite(record.top_k) && record.top_k > 0
              ? Math.floor(record.top_k)
              : undefined;

  if (queries.length === 0) {
    return undefined;
  }

  const displayedQueries = queries.slice(0, 3).map((query) => `"${query}"`);
  const queryText =
    queries.length > displayedQueries.length
      ? `${displayedQueries.join(", ")}…`
      : displayedQueries.join(", ");

  return count !== undefined ? `for ${queryText} (top ${count})` : `for ${queryText}`;
}

function collectWebSearchQueries(record: Record<string, unknown>): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeOptionalString(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    queries.push(normalized);
  };

  add(record.query);
  add(record.q);
  add(record.search);
  add(record.input);
  // Parallel's `web_search` provider uses the native Parallel Search shape
  // (`objective` + `search_queries`). Surface those so CLI progress and
  // Codex activity metadata render the query context instead of a bare
  // `search`.
  add(record.objective);

  for (const key of ["search_query", "image_query", "queries", "search_queries"]) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string") {
        add(entry);
        continue;
      }
      const entryRecord = asRecord(entry);
      if (!entryRecord) {
        continue;
      }
      add(entryRecord.query);
      add(entryRecord.q);
      add(entryRecord.search);
    }
  }

  return queries;
}

function resolveWebFetchDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const url = normalizeOptionalString(record.url);
  if (!url) {
    return undefined;
  }

  const mode = normalizeOptionalString(record.extractMode);
  const maxChars =
    typeof record.maxChars === "number" && Number.isFinite(record.maxChars) && record.maxChars > 0
      ? Math.floor(record.maxChars)
      : undefined;

  let suffix = "";
  if (mode) {
    suffix = `mode ${mode}`;
  }
  if (maxChars !== undefined) {
    suffix = suffix ? `${suffix}, max ${maxChars} chars` : `max ${maxChars} chars`;
  }

  return suffix ? `from ${url} (${suffix})` : `from ${url}`;
}
