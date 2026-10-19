import { useCallback, useMemo, useState } from 'react';
import { buildSessionIdentityKey, type SessionIdentity } from '../../types/desktop/runtime-address';
import type { ToolActivityDisclosure } from './tool-renderers/types';

const EMPTY_EXPANDED_KEYS: ReadonlySet<string> = new Set();

export function useToolActivityDisclosure(sessionIdentity?: SessionIdentity, collapseVersion = 0): ToolActivityDisclosure {
  const identityKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null;
  const [state, setState] = useState(() => ({ identityKey, collapseVersion, expandedKeys: EMPTY_EXPANDED_KEYS }));
  if (state.identityKey !== identityKey || state.collapseVersion !== collapseVersion) {
    setState({ identityKey, collapseVersion, expandedKeys: EMPTY_EXPANDED_KEYS });
  }
  const expandedKeys = state.identityKey === identityKey && state.collapseVersion === collapseVersion
    ? state.expandedKeys : EMPTY_EXPANDED_KEYS;
  const toggle = useCallback((key: string) => {
    setState((current) => {
      const next = new Set(current.identityKey === identityKey && current.collapseVersion === collapseVersion
        ? current.expandedKeys : EMPTY_EXPANDED_KEYS);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { identityKey, collapseVersion, expandedKeys: next };
    });
  }, [identityKey, collapseVersion]);
  const collapse = useCallback(() => {
    setState((current) => current.identityKey === identityKey && current.collapseVersion === collapseVersion && current.expandedKeys.size === 0
      ? current : { identityKey, collapseVersion, expandedKeys: EMPTY_EXPANDED_KEYS });
  }, [identityKey, collapseVersion]);
  return useMemo(() => ({ expandedKeys, toggle, collapse }), [expandedKeys, toggle, collapse]);
}
