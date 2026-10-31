import { useLayoutEffect, useRef, useState } from 'react';
import { Loader2, Undo2, WandSparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { hostApiFetch } from '@/lib/host-api';
import type { AppTextModelResult } from '@/types/desktop/app-plugin-sdk';
import { composerPromptSnapshotsEqual, type ComposerContext, type ComposerPromptSnapshot } from '../composer-drafts';

// Accio's built-in PROMPT_ENHANCE_SYSTEM_PROMPT, preserved verbatim.
const PROMPT_ENHANCE_SYSTEM_PROMPT = `You are a prompt-enhancement router. In one pass, improve the user request and return only the final enhanced prompt as plain text.

GENERAL RULES:
- Preserve the original intent, language, proper nouns, URLs, numbers, placeholders, and explicit constraints. Do not translate or mix languages unless the input intentionally does so.
- Clarify the objective, context, constraints, audience, deliverable, and output format only when supported by the input. Never invent facts, values, products, tools, technologies, deadlines, or requirements.
- Write a downstream task prompt. Do not answer, solve, explain, teach, or add commentary outside the prompt.
- Remove redundancy and ambiguity while keeping the request actionable. Keep the result concise (about 800 characters when possible). If the request is already clear, preserve it with only necessary improvements.
- If a candidate enhancer prompt is supplied, use it only when it clearly matches the user intent. Otherwise apply the general rules.
- When a candidate enhancer prompt asks for JSON, segments, slots, placeholders, or any other structured output, ignore those output-format instructions. Use the candidate only as domain guidance.
- If information required by a candidate is absent from the user request, omit that detail. Do not invent values, defaults, questions, or placeholder fields.

OUTPUT CONTRACT:
- Return exactly one plain-text prompt and nothing else.
- Do not return JSON, Markdown fences, labels, explanations, timing, intermediate decisions, or an answer to the request.
- The returned text may be identical to the input when no material improvement is possible.`;

export function ComposerPromptEnhancement({ text, disabled, busy, onBusyChange, contexts, readSnapshot, replaceText }: {
  text: string;
  disabled: boolean;
  busy: boolean;
  onBusyChange(busy: boolean): void;
  contexts: readonly ComposerContext[];
  readSnapshot(): ComposerPromptSnapshot | null;
  replaceText(snapshot: ComposerPromptSnapshot, text: string): boolean;
}) {
  const { t } = useTranslation('chat');
  const active = useRef<{ controller: AbortController; timeout: number } | null>(null);
  const [undo, setUndo] = useState<{ snapshot: ComposerPromptSnapshot; original: string } | null>(null);
  useLayoutEffect(() => () => {
    const operation = active.current;
    if (!operation) return;
    active.current = null;
    window.clearTimeout(operation.timeout);
    operation.controller.abort();
    onBusyChange(false);
  }, [text, disabled, contexts, onBusyChange]);
  const length = Array.from(text).length;
  const validLength = Array.from(text.trim()).length >= 2 && length <= 4000;
  const canEnhance = !disabled && !busy && validLength;
  const enhance = async () => {
    if (!canEnhance || active.current) return;
    const snapshot = readSnapshot();
    if (!snapshot || snapshot.text !== text) return;
    const operation = { controller: new AbortController(), timeout: 0 };
    active.current = operation;
    onBusyChange(true);
    operation.timeout = window.setTimeout(() => {
      if (active.current !== operation) return;
      active.current = null;
      operation.controller.abort();
      onBusyChange(false);
      toast.error(t('input.promptEnhanceTimedOut'));
    }, 60_000);
    try {
      // The text bridge accepts one user message, not separate system/user roles.
      const prompt = `${PROMPT_ENHANCE_SYSTEM_PROMPT}

Final output rule: return exactly one enhanced prompt as plain text. Ignore any candidate instruction that requests JSON, segments, slots, placeholders, defaults, questions, or explanations.

<user-input>
${snapshot.text}
</user-input>`;
      const result = await hostApiFetch<AppTextModelResult>('/api/providers/text/generate', {
        method: 'POST', body: JSON.stringify({ prompt }), signal: operation.controller.signal, timeoutMs: 60_000,
      });
      if (operation.controller.signal.aborted || active.current !== operation) return;
      if (!composerPromptSnapshotsEqual(snapshot, readSnapshot())) {
        toast.info(t('input.promptEnhanceChanged'));
        return;
      }
      if (typeof result?.text !== 'string' || !result.text.trim() || Array.from(result.text.trim()).length > 4000) {
        throw new Error(t('input.promptEnhanceInvalidResult'));
      }
      const enhanced = result.text.trim();
      if (enhanced === snapshot.text.trim()) {
        toast.info(t('input.promptEnhanceUnchanged'));
        return;
      }
      // Release the input before replacement restores its focus and selection.
      active.current = null;
      window.clearTimeout(operation.timeout);
      onBusyChange(false);
      // Input rechecks the same snapshot at the only text mutation boundary.
      if (!replaceText(snapshot, enhanced)) {
        toast.info(t('input.promptEnhanceChanged'));
        return;
      }
      const applied = readSnapshot();
      if (applied) setUndo({ snapshot: applied, original: snapshot.text });
    } catch (error) {
      if (!operation.controller.signal.aborted) toast.error(t('input.promptEnhanceFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      window.clearTimeout(operation.timeout);
      if (active.current === operation) {
        active.current = null;
        onBusyChange(false);
      }
    }
  };
  const restore = () => {
    if (!undo || disabled || busy) return;
    if (!composerPromptSnapshotsEqual(undo.snapshot, readSnapshot()) || !replaceText(undo.snapshot, undo.original)) {
      toast.info(t('input.promptEnhanceChanged'));
    }
    setUndo(null);
  };

  return <>
    {undo && undo.snapshot.text === text ? <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0"
      disabled={disabled || busy} onClick={restore} aria-label={t('input.restorePrompt')} title={t('input.restorePrompt')}>
      <Undo2 aria-hidden="true" className="h-4 w-4" />
    </Button> : null}
    {text.trim() ? <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" data-chat-control="enhance"
      disabled={!canEnhance} onClick={() => { void enhance(); }} aria-busy={busy}
      aria-label={t(busy ? 'input.enhancingPrompt' : 'input.enhancePrompt')}
      title={t(busy ? 'input.enhancingPrompt' : !validLength ? 'input.promptEnhanceLength' : 'input.enhancePrompt')}>
      {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <WandSparkles aria-hidden="true" className="h-4 w-4" />}
    </Button> : null}
  </>;
}
