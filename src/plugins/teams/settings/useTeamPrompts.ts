import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { teamPromptsApi } from '@/lib/team-prompts-api';
import type { TeamPromptCatalog } from '@/types/team-prompts';

type InvalidField = { key: string; slots: string[] };
type Failure = { cause: unknown; recovery: 'conflict' | 'unknown' | null };

function validate(values: Record<string, string>, defaults: Record<string, string>): InvalidField | null {
  for (const [key, original] of Object.entries(defaults)) {
    const value = values[key] ?? '';
    if (!value.trim()) return { key, slots: [] };
    const expected = original.match(/\{\{[^{}]+\}\}/g) ?? [];
    const actual = value.match(/\{\{[^{}]+\}\}/g) ?? [];
    const slots = [...new Set([...expected, ...actual])]
      .filter((slot) => actual.filter((value) => value === slot).length !== expected.filter((value) => value === slot).length);
    if (slots.length) return { key, slots };
  }
  return null;
}

export function useTeamPrompts(active: boolean) {
  const [catalog, setCatalog] = useState<TeamPromptCatalog | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [operation, setOperation] = useState<'load' | 'save' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const initialized = useRef(false);
  const pending = useRef(false);
  const dirty = catalog !== null && Object.keys(catalog.defaults).some((key) => draft[key] !== catalog.values[key]);
  const invalid = useMemo(() => catalog ? validate(draft, catalog.defaults) : null, [catalog, draft]);
  const recovery = failure?.recovery ?? null;

  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setOperation('load');
    try {
      const next = await teamPromptsApi.read();
      setDraft((current) => {
        if (!catalog) return next.values;
        // An explicit conflict reload keeps local edits, not stale untouched fields.
        const edits = Object.entries(current).filter(([key, value]) => value !== catalog.values[key]);
        return { ...next.values, ...Object.fromEntries(edits) };
      });
      setCatalog(next);
      setFailure(null);
    } catch (cause) {
      setFailure((current) => ({ cause, recovery: current?.recovery ?? null }));
    } finally {
      pending.current = false;
      setOperation(null);
    }
  }, [catalog]);

  useEffect(() => {
    if (!active || initialized.current) return;
    initialized.current = true;
    void load();
  }, [active, load]);

  const update = (values: Record<string, string>) => {
    if (pending.current) return;
    setDraft((current) => ({ ...current, ...values }));
    if (!recovery) setFailure(null);
  };

  const discard = () => {
    if (!catalog || pending.current) return;
    setDraft(catalog.values);
    if (!recovery) setFailure(null);
  };

  const save = async () => {
    if (!catalog || pending.current || !dirty || invalid || recovery) return;
    pending.current = true;
    setOperation('save');
    setFailure(null);
    try {
      const saved = await teamPromptsApi.save(catalog.revision, draft);
      setCatalog({ ...catalog, ...saved });
      setDraft(saved.values);
    } catch (cause) {
      const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : null;
      setFailure({ cause, recovery: code === 'TEAM_PROMPTS_CONFLICT' ? 'conflict' : code === 'TEAM_PROMPTS_OUTCOME_UNKNOWN' ? 'unknown' : null });
    } finally {
      pending.current = false;
      setOperation(null);
    }
  };

  return { catalog, draft, dirty, invalid, operation, failure, recovery, load, update, discard, save };
}
