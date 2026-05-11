function isProviderModelRef(value: unknown, provider: string): boolean {
  return typeof value === 'string' && value.startsWith(`${provider}/`);
}

function pruneModelValueForProvider(value: unknown, provider: string): unknown | undefined {
  if (typeof value === 'string') {
    return isProviderModelRef(value, provider) ? undefined : value;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const modelObject = { ...(value as Record<string, unknown>) };
  const primary = typeof modelObject.primary === 'string' ? modelObject.primary : undefined;
  const rawFallbacks = Array.isArray(modelObject.fallbacks) ? modelObject.fallbacks : [];

  const filteredFallbacks: string[] = [];
  const seenFallbacks = new Set<string>();
  for (const fallback of rawFallbacks) {
    if (typeof fallback !== 'string') {
      continue;
    }
    if (isProviderModelRef(fallback, provider) || seenFallbacks.has(fallback)) {
      continue;
    }
    seenFallbacks.add(fallback);
    filteredFallbacks.push(fallback);
  }

  let nextPrimary = primary;
  if (!nextPrimary || isProviderModelRef(nextPrimary, provider)) {
    nextPrimary = filteredFallbacks.shift();
  }
  if (nextPrimary && filteredFallbacks[0] === nextPrimary) {
    filteredFallbacks.shift();
  }

  if (!nextPrimary) {
    return undefined;
  }

  modelObject.primary = nextPrimary;
  if (filteredFallbacks.length > 0) {
    modelObject.fallbacks = filteredFallbacks;
  } else {
    delete modelObject.fallbacks;
  }

  return modelObject;
}

export function pruneProviderModelRefsInAgentsConfig(config: Record<string, unknown>, provider: string): boolean {
  const agents = config.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
    return false;
  }

  const agentsObject = agents as Record<string, unknown>;
  let changed = false;

  const defaults = agentsObject.defaults;
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    const defaultsObject = defaults as Record<string, unknown>;
    if ('model' in defaultsObject) {
      const previous = defaultsObject.model;
      const next = pruneModelValueForProvider(previous, provider);
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        changed = true;
        if (next === undefined) {
          delete defaultsObject.model;
        } else {
          defaultsObject.model = next;
        }
      }
    }
  }

  const list = agentsObject.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const entryObject = entry as Record<string, unknown>;
      if (!('model' in entryObject)) {
        continue;
      }
      const previous = entryObject.model;
      const next = pruneModelValueForProvider(previous, provider);
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        changed = true;
        if (next === undefined) {
          delete entryObject.model;
        } else {
          entryObject.model = next;
        }
      }
    }
  }

  return changed;
}
