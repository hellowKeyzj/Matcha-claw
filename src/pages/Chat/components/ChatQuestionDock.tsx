import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { OpenClawPendingQuestionRecord, OpenClawQuestion } from '@/types/openclaw-question';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';

type QuestionDraft = {
  selectedAnswers: Record<string, string[]>;
  otherAnswers: Record<string, string>;
  otherSelected: Record<string, boolean>;
  index: number;
  error: 'questions.submitFailed' | null;
};

const EMPTY_DRAFT: QuestionDraft = {
  selectedAnswers: {}, otherAnswers: {}, otherSelected: {}, index: 0, error: null,
};
const NAV_BUTTON = 'inline-flex h-8 items-center justify-center rounded-full px-3 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-45';
const ACTION_BUTTON = 'ml-auto inline-flex h-8 items-center justify-center rounded-full bg-[hsl(var(--shell-icon-active))] px-3 text-[12px] font-medium text-[hsl(var(--shell-window))] disabled:opacity-45';

function selectedAnswerValues(question: OpenClawQuestion, draft: QuestionDraft): string[] {
  const id = question.questionId;
  const other = Object.hasOwn(draft.otherAnswers, id) ? draft.otherAnswers[id].trim() : '';
  if (!question.multiSelect && Object.hasOwn(draft.otherSelected, id) && draft.otherSelected[id]) return other ? [other] : [];
  const answers = Object.hasOwn(draft.selectedAnswers, id) ? [...draft.selectedAnswers[id]] : [];
  if (other) answers.push(other);
  return answers;
}

export function ChatQuestionDock({
  questions,
  confirmed,
  error,
  submittingId,
  onRefresh,
  onResolve,
}: {
  questions: OpenClawPendingQuestionRecord[];
  confirmed: boolean;
  error: 'questions.loadFailed' | null;
  submittingId: string | null;
  onRefresh: () => void;
  onResolve: (id: string, answers: Record<string, string[]>) => Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const groupId = useId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const pending = useRef(questions);
  const mounted = useRef(true);
  pending.current = questions;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    setDrafts((current) => Object.fromEntries(
      questions.filter((record) => current[record.id]).map((record) => [record.id, current[record.id]]),
    ));
  }, [questions]);
  const activeIndex = Math.max(0, questions.findIndex((record) => record.id === activeId));
  const record = questions[activeIndex];
  if (!record) {
    return error ? (
      <div className={`${CHAT_LAYOUT_TOKENS.runtimeDockRail} flex items-center gap-2 rounded-[18px] border border-border/45 bg-card p-3 text-sm`} role="status">
        <span>{t(error)}</span>
        <button type="button" className={NAV_BUTTON} onClick={onRefresh}>{t('questions.retry')}</button>
      </div>
    ) : null;
  }
  const draft = drafts[record.id] ?? EMPTY_DRAFT;
  const index = Math.min(draft.index, record.questions.length - 1);
  const question = record.questions[index]!;
  const otherAnswer = Object.hasOwn(draft.otherAnswers, question.questionId) ? draft.otherAnswers[question.questionId] : '';
  const otherSelected = Object.hasOwn(draft.otherSelected, question.questionId) && draft.otherSelected[question.questionId];
  const answers = Object.fromEntries(record.questions.map((item) => [item.questionId, selectedAnswerValues(item, draft)]));
  const currentAnswers = answers[question.questionId];
  const expired = record.expiresAtMs <= Date.now();
  const disabled = !confirmed || expired || submittingId !== null;
  const isLastQuestion = index === record.questions.length - 1;
  const canSubmit = record.questions.every((item) => answers[item.questionId].length > 0);
  const statusError = error ?? (expired ? 'questions.expired' : draft.error);
  const updateDraft = (update: (current: QuestionDraft) => QuestionDraft) => {
    if (!mounted.current || !pending.current.some((item) => item.id === record.id)) return;
    setDrafts((current) => ({ ...current, [record.id]: update(current[record.id] ?? EMPTY_DRAFT) }));
  };
  const toggleOption = (label: string) => {
    updateDraft((current) => {
      const selected = Object.hasOwn(current.selectedAnswers, question.questionId) ? current.selectedAnswers[question.questionId] : [];
      return {
        ...current,
        error: null,
        selectedAnswers: {
          ...current.selectedAnswers,
          [question.questionId]: question.multiSelect
            ? selected.includes(label) ? selected.filter((value) => value !== label) : [...selected, label]
            : [label],
        },
        ...(!question.multiSelect ? {
          otherAnswers: { ...current.otherAnswers, [question.questionId]: '' },
          otherSelected: { ...current.otherSelected, [question.questionId]: false },
        } : {}),
      };
    });
  };
  const updateOther = (value: string) => {
    updateDraft((current) => ({
      ...current,
      error: null,
      otherAnswers: { ...current.otherAnswers, [question.questionId]: value },
      ...(!question.multiSelect ? {
        selectedAnswers: { ...current.selectedAnswers, [question.questionId]: [] },
        otherSelected: { ...current.otherSelected, [question.questionId]: true },
      } : {}),
    }));
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || disabled) return;
    updateDraft((current) => ({ ...current, error: null }));
    try {
      await onResolve(record.id, answers);
    } catch {
      updateDraft((current) => ({ ...current, error: 'questions.submitFailed' }));
    }
  };

  return (
    <form
      className={`${CHAT_LAYOUT_TOKENS.runtimeDockRail} flex max-h-[min(40vh,24rem)] flex-col overflow-hidden rounded-[18px] border border-border/45 bg-card text-sm shadow-sm`}
      onSubmit={submit}
    >
      <div className="shrink-0 border-b border-border/45 px-3.5 py-2.5">
        {questions.length > 1 ? (
          <div className="mb-2 flex items-center justify-end gap-1" aria-label={t('questions.switchRequest')}>
            <button type="button" className={NAV_BUTTON} disabled={activeIndex === 0} onClick={() => setActiveId(questions[activeIndex - 1].id)}>{t('questions.previousRequest')}</button>
            <span className="text-[11px] text-muted-foreground">{activeIndex + 1}/{questions.length}</span>
            <button type="button" className={NAV_BUTTON} disabled={activeIndex === questions.length - 1} onClick={() => setActiveId(questions[activeIndex + 1].id)}>{t('questions.nextRequest')}</button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {question.header ? <span className="min-w-0 truncate rounded-full border border-border/45 bg-muted/55 px-2 py-0.5" title={question.header}>{question.header}</span> : null}
          {question.multiSelect ? <span className="shrink-0">{t('questions.multiple')}</span> : null}
          <span className="ml-auto shrink-0" aria-live="polite">{t('questions.progress', { current: index + 1, total: record.questions.length })}</span>
        </div>
      </div>
      <div
        key={`${record.id}:${question.questionId}`}
        className="min-h-0 overflow-y-auto overscroll-contain p-3.5"
        data-chat-composer-wheel-local="true"
      >
        <fieldset disabled={disabled} className="min-w-0">
          <legend className="mb-2 w-full whitespace-pre-wrap break-words text-[13px] font-medium leading-5 text-foreground">{question.question}</legend>
          <div className="grid gap-1.5">
            {question.options.map((option) => {
              const selected = currentAnswers.includes(option.label) && !(!question.multiSelect && otherSelected);
              return (
                <label key={option.label} className={`flex items-start gap-2 rounded-[12px] border px-3 py-2 text-[12px] ${selected ? 'border-sky-500/70 bg-sky-500/10' : 'border-border/50 bg-muted/45'} ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-muted'}`}>
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={`${groupId}:${record.id}:${question.questionId}`}
                    checked={selected}
                    className="mt-0.5 shrink-0 accent-sky-500"
                    onChange={() => toggleOption(option.label)}
                  />
                  <span className="min-w-0 whitespace-pre-wrap break-words">
                    <strong className="block font-medium">{option.label}</strong>
                    {option.description ? <small className="mt-0.5 block text-muted-foreground">{option.description}</small> : null}
                  </span>
                </label>
              );
            })}
            {question.options.length === 0 || question.isOther === true ? (
              <div className="rounded-[12px] border border-border/50 bg-muted/45 px-3 py-2 focus-within:ring-2 focus-within:ring-border/50">
                <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  {!question.multiSelect && question.options.length > 0 ? (
                    <input
                      type="radio"
                      name={`${groupId}:${record.id}:${question.questionId}`}
                      checked={otherSelected}
                      className="accent-sky-500"
                      onChange={() => updateOther(otherAnswer)}
                    />
                  ) : null}
                  <span>{t(question.options.length === 0 ? 'questions.yourAnswer' : 'questions.otherAnswer')}</span>
                </label>
                <textarea
                  aria-label={t(question.options.length === 0 ? 'questions.yourAnswer' : 'questions.otherAnswer')}
                  value={otherAnswer}
                  rows={question.options.length === 0 ? 2 : 1}
                  className="mt-1 block w-full min-w-0 resize-y bg-transparent text-[12px] text-foreground outline-none"
                  onChange={(event) => updateOther(event.target.value)}
                />
              </div>
            ) : null}
          </div>
        </fieldset>
      </div>
      <div className="shrink-0 border-t border-border/45 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {index > 0 ? (
            <button type="button" disabled={disabled} className={NAV_BUTTON} onClick={() => updateDraft((current) => ({ ...current, index: index - 1 }))}>{t('questions.previous')}</button>
          ) : null}
          {!isLastQuestion ? (
            <button type="button" disabled={disabled || currentAnswers.length === 0} className={ACTION_BUTTON} onClick={() => updateDraft((current) => ({ ...current, index: index + 1 }))}>{t('questions.next')}</button>
          ) : (
            <button type="submit" disabled={disabled || !canSubmit} className={ACTION_BUTTON}>{t(submittingId === record.id ? 'questions.submitting' : 'questions.submit')}</button>
          )}
        </div>
        {statusError ? (
          <div className="mt-2 flex items-center gap-2 text-[12px]" role="status">
            <span className="text-destructive">{t(statusError)}</span>
            <button type="button" disabled={submittingId !== null} className={NAV_BUTTON} onClick={onRefresh}>{t('questions.retry')}</button>
          </div>
        ) : !confirmed && submittingId === null ? <p className="mt-2 text-[12px] text-muted-foreground" role="status">{t('questions.confirming')}</p> : null}
      </div>
    </form>
  );
}
