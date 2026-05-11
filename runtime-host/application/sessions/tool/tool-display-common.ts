import {
  coerceDisplayValue,
  lookupValueByPath,
  normalizeVerb,
  resolveActionArg,
  type CoerceDisplayValueOptions,
  type ToolDisplayActionSpec,
  type ToolDisplaySpec,
} from './tool-display-format';
import { resolveKnownToolDetail } from './tool-display-detail-resolvers';

export function resolveActionSpec(
  spec: ToolDisplaySpec | undefined,
  action: string | undefined,
): ToolDisplayActionSpec | undefined {
  if (!spec || !action) {
    return undefined;
  }
  return spec.actions?.[action] ?? undefined;
}

export function resolveDetailFromKeys(
  args: unknown,
  keys: string[],
  opts: {
    mode: 'first' | 'summary';
    coerce?: CoerceDisplayValueOptions;
    maxEntries?: number;
    formatKey?: (raw: string) => string;
  },
): string | undefined {
  if (opts.mode === 'first') {
    for (const key of keys) {
      const value = lookupValueByPath(args, key);
      const display = coerceDisplayValue(value, opts.coerce);
      if (display) {
        return display;
      }
    }
    return undefined;
  }

  const entries: Array<{ label: string; value: string }> = [];
  for (const key of keys) {
    const value = lookupValueByPath(args, key);
    const display = coerceDisplayValue(value, opts.coerce);
    if (!display) {
      continue;
    }
    entries.push({
      label: opts.formatKey ? opts.formatKey(key) : key,
      value: display,
    });
  }
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return entries[0]?.value;
  }

  const seen = new Set<string>();
  const unique: Array<{ label: string; value: string }> = [];
  for (const entry of entries) {
    const token = `${entry.label}:${entry.value}`;
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(entry);
  }
  if (unique.length === 0) {
    return undefined;
  }

  return unique
    .slice(0, opts.maxEntries ?? 8)
    .map((entry) => `${entry.label} ${entry.value}`)
    .join(' · ');
}

export function resolveToolVerbAndDetail(params: {
  toolKey: string;
  args?: unknown;
  meta?: string;
  action?: string;
  spec?: ToolDisplaySpec;
  fallbackDetailKeys?: string[];
  detailMode: 'first' | 'summary';
  detailCoerce?: CoerceDisplayValueOptions;
  detailMaxEntries?: number;
  detailFormatKey?: (raw: string) => string;
  resolveExecDetail?: (args: unknown) => string | undefined;
}): { verb?: string; detail?: string } {
  const actionSpec = resolveActionSpec(params.spec, params.action);
  const fallbackVerb =
    params.toolKey === 'web_search'
      ? '搜索'
      : params.toolKey === 'web_fetch'
        ? '抓取'
        : params.toolKey.replace(/_/g, ' ').replace(/\./g, ' ');
  const verb = normalizeVerb(actionSpec?.label ?? params.action ?? fallbackVerb);

  let detail = resolveKnownToolDetail({
    toolKey: params.toolKey,
    args: params.args,
    action: params.action,
    resolveExecDetail: params.resolveExecDetail,
  });

  const detailKeys =
    actionSpec?.detailKeys ?? params.spec?.detailKeys ?? params.fallbackDetailKeys ?? [];
  if (!detail && detailKeys.length > 0) {
    detail = resolveDetailFromKeys(params.args, detailKeys, {
      mode: params.detailMode,
      coerce: params.detailCoerce,
      maxEntries: params.detailMaxEntries,
      formatKey: params.detailFormatKey,
    });
  }
  if (!detail && params.meta) {
    detail = params.meta;
  }

  return { verb, detail };
}

export function resolveToolVerbAndDetailForArgs(params: {
  toolKey: string;
  args?: unknown;
  meta?: string;
  spec?: ToolDisplaySpec;
  fallbackDetailKeys?: string[];
  detailMode: 'first' | 'summary';
  detailCoerce?: CoerceDisplayValueOptions;
  detailMaxEntries?: number;
  detailFormatKey?: (raw: string) => string;
  resolveExecDetail?: (args: unknown) => string | undefined;
}): { verb?: string; detail?: string } {
  return resolveToolVerbAndDetail({
    toolKey: params.toolKey,
    args: params.args,
    meta: params.meta,
    action: resolveActionArg(params.args),
    spec: params.spec,
    fallbackDetailKeys: params.fallbackDetailKeys,
    detailMode: params.detailMode,
    detailCoerce: params.detailCoerce,
    detailMaxEntries: params.detailMaxEntries,
    detailFormatKey: params.detailFormatKey,
    resolveExecDetail: params.resolveExecDetail,
  });
}
