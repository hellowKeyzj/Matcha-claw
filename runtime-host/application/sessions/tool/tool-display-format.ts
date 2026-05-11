export type ToolDisplayActionSpec = {
  label?: string;
  detailKeys?: string[];
};

export type ToolDisplaySpec = {
  title?: string;
  label?: string;
  detailKeys?: string[];
  actions?: Record<string, ToolDisplayActionSpec>;
};

export type CoerceDisplayValueOptions = {
  includeFalse?: boolean;
  includeZero?: boolean;
  includeNonFinite?: boolean;
  maxStringChars?: number;
  maxArrayEntries?: number;
};

export type ToolDisplayArgsRecord = Record<string, unknown>;

export function joinDetailParts(parts: Array<string | undefined>): string | undefined {
  const normalized = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return normalized.length > 0 ? normalized.join(' · ') : undefined;
}

export function quoteText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? `“${trimmed}”` : undefined;
}

export function previewText(value: string | undefined, maxChars = 40): string | undefined {
  if (!value) {
    return undefined;
  }
  return coerceDisplayValue(value, { maxStringChars: maxChars });
}

export function resolveArrayPreview(
  value: unknown,
  opts: CoerceDisplayValueOptions = {},
): string | undefined {
  return Array.isArray(value) ? coerceDisplayValue(value, opts) : undefined;
}

export function asRecord(args: unknown): ToolDisplayArgsRecord | undefined {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as ToolDisplayArgsRecord
    : undefined;
}

export function normalizeToolName(name?: string): string {
  return (name ?? 'tool').trim();
}

export function defaultTitle(name: string): string {
  const cleaned = name.replace(/_/g, ' ').trim();
  if (!cleaned) {
    return '工具';
  }
  return cleaned
    .split(/\s+/)
    .map((part) => `${part.at(0)?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

export function normalizeVerb(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/_/g, ' ');
}

export function resolveActionArg(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record || typeof record.action !== 'string') {
    return undefined;
  }
  const action = record.action.trim();
  return action || undefined;
}

export function coerceDisplayValue(
  value: unknown,
  opts: CoerceDisplayValueOptions = {},
): string | undefined {
  const maxStringChars = opts.maxStringChars ?? 72;
  const maxArrayEntries = opts.maxArrayEntries ?? 3;

  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? '';
    if (!firstLine) {
      return undefined;
    }
    if (firstLine.length > maxStringChars) {
      return `${firstLine.slice(0, Math.max(0, maxStringChars - 1))}…`;
    }
    return firstLine;
  }
  if (typeof value === 'boolean') {
    if (!value && !opts.includeFalse) {
      return undefined;
    }
    return value ? '是' : '否';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return opts.includeNonFinite ? String(value) : undefined;
    }
    if (value === 0 && !opts.includeZero) {
      return undefined;
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((item) => coerceDisplayValue(item, opts))
      .filter((item): item is string => Boolean(item));
    if (values.length === 0) {
      return undefined;
    }
    const preview = values.slice(0, maxArrayEntries).join('、');
    return values.length > maxArrayEntries ? `${preview}…` : preview;
  }
  return undefined;
}

export function lookupValueByPath(args: unknown, path: string): unknown {
  if (!args || typeof args !== 'object') {
    return undefined;
  }
  let current: unknown = args;
  for (const segment of path.split('.')) {
    if (!segment || !current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function formatDetailKey(raw: string, overrides: Record<string, string> = {}): string {
  const segments = raw.split('.').filter(Boolean);
  const last = segments.at(-1) ?? raw;
  const override = overrides[last];
  if (override) {
    return override;
  }
  const cleaned = last.replace(/_/g, ' ').replace(/-/g, ' ');
  const spaced = cleaned.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.trim().toLowerCase() || last.toLowerCase();
}

export function formatToolDetailText(
  detail: string | undefined,
  opts: { prefixWithWith?: boolean } = {},
): string | undefined {
  if (!detail) {
    return undefined;
  }
  const normalized = detail.includes(' · ')
    ? detail
        .split(' · ')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join('，')
    : detail;
  if (!normalized) {
    return undefined;
  }
  return opts.prefixWithWith ? `执行：${normalized}` : normalized;
}

export function resolvePathArg(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  for (const candidate of [record.path, record.file_path, record.filePath, record.file]) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
