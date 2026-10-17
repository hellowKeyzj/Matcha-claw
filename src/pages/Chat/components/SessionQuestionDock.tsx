import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { JsonObject, SessionQuestionAnswer, SessionQuestionTarget, SessionQuestionView } from '@/types/session-question';
import { sessionQuestionKey } from '../useSessionQuestions';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';

type FormField = { name: string; type: 'string' | 'boolean' | 'number' | 'integer'; title: string; description?: string; required: boolean; values?: string[] };
function formFields(schema: JsonObject | undefined): FormField[] | null {
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)
    || Object.keys(schema).some((key) => !['type', 'properties', 'required', 'title', 'description'].includes(key))) return null;
  const properties = schema.properties;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || !required.every((key) => typeof key === 'string' && Object.hasOwn(properties, key))) return null;
  const fields: FormField[] = [];
  for (const [name, field] of Object.entries(properties)) {
    if (!field || typeof field !== 'object' || Array.isArray(field)
      || Object.keys(field).some((key) => !['type', 'title', 'description', 'enum'].includes(key))
      || !['string', 'boolean', 'number', 'integer'].includes(String(field.type))
      || (field.title !== undefined && typeof field.title !== 'string')
      || (field.description !== undefined && typeof field.description !== 'string')
      || (field.enum !== undefined && (field.type !== 'string' || !Array.isArray(field.enum) || !field.enum.every((value) => typeof value === 'string')))) return null;
    fields.push({ name, type: field.type as FormField['type'], title: typeof field.title === 'string' ? field.title : name,
      required: required.includes(name), ...(typeof field.description === 'string' ? { description: field.description } : {}),
      ...(Array.isArray(field.enum) ? { values: field.enum as string[] } : {}) });
  }
  return fields;
}
const BUTTON = 'inline-flex h-8 items-center justify-center rounded-full px-3 text-xs font-medium hover:bg-muted disabled:opacity-45';
const INPUT = 'w-full rounded-lg border border-border/60 bg-background px-2 py-1.5 text-sm';

type Props = {
  questions: SessionQuestionView[];
  confirmed: boolean;
  error: string | null;
  submittingId: string | null;
  onRefresh: () => void;
  onRespond: (target: SessionQuestionTarget, answer: SessionQuestionAnswer) => Promise<void>;
};
export function SessionQuestionDock(props: Props) {
  const { t } = useTranslation('chat');
  const [activeId, setActiveId] = useState('');
  const selectedIndex = props.questions.findIndex((question) => sessionQuestionKey(question.target) === activeId);
  const index = selectedIndex >= 0 ? selectedIndex : Math.max(0, props.questions.findIndex((question) => question.availability === 'pending' && question.delivery === 'notSent'));
  const record = props.questions[index];
  if (!record) return props.error ? <div className={`${CHAT_LAYOUT_TOKENS.runtimeDockRail} rounded-[18px] border border-border/45 bg-card p-3 text-sm`} role="status">
    {t('questions.loadFailed')}<button type="button" className={BUTTON} onClick={props.onRefresh}>{t('questions.retry')}</button>
  </div> : null;
  return <div className={`${CHAT_LAYOUT_TOKENS.runtimeDockRail} max-h-[min(40vh,24rem)] overflow-y-auto rounded-[18px] border border-border/45 bg-card p-3 text-sm`} data-chat-composer-wheel-local="true">
    {props.questions.length > 1 && <div className="flex items-center justify-end gap-1">
      <button type="button" className={BUTTON} disabled={index === 0} onClick={() => setActiveId(sessionQuestionKey(props.questions[index - 1].target))}>{t('questions.previousRequest')}</button>
      <span>{index + 1}/{props.questions.length}</span>
      <button type="button" className={BUTTON} disabled={index === props.questions.length - 1} onClick={() => setActiveId(sessionQuestionKey(props.questions[index + 1].target))}>{t('questions.nextRequest')}</button>
    </div>}
    <SessionQuestionForm key={sessionQuestionKey(record.target)} {...props} record={record} />
  </div>;
}
function SessionQuestionForm({ record, confirmed, error, submittingId, onRefresh, onRespond }: Props & { record: SessionQuestionView }) {
  const { t } = useTranslation('chat');
  const id = useId();
  const [submitError, setSubmitError] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const request = record.request;
  const fields = request.type === 'elicitationForm' ? formFields(request.requestedSchema) : null;
  const disabled = !confirmed || submittingId !== null || record.availability !== 'pending' || record.delivery !== 'notSent';
  const send = async (answer: SessionQuestionAnswer) => {
    if (disabled) return;
    setSubmitError(false);
    try { await onRespond(record.target, answer); } catch { if (mounted.current) setSubmitError(true); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    const data = new FormData(event.currentTarget);
    if (request.type === 'askUserQuestion') {
      const entries = request.questions.map((question, index) => {
        const selected = data.getAll(`answer:${index}`).map(String);
        const other = String(data.get(`other:${index}`) ?? '').trim();
        return [question.question, other ? question.multiSelect ? [...selected, other].join(', ') : other : selected.join(', ')] as const;
      });
      if (request.questions.some((_, index) => data.getAll(`answer:${index}`).length === 0 && !String(data.get(`other:${index}`) ?? '').trim())) {
        setSubmitError(true);
        return;
      }
      const answers = Object.fromEntries(entries);
      const annotations = Object.fromEntries(request.questions.flatMap((question, index) => {
        const preview = question.options.find((option) => option.label === answers[question.question])?.preview;
        const notes = String(data.get(`notes:${index}`) ?? '').trim();
        return preview || notes ? [[question.question, { ...(preview ? { preview } : {}), ...(notes ? { notes } : {}) }]] : [];
      }));
      void send({ type: 'askUserQuestion', answer: { action: 'answer', answers, ...(Object.keys(annotations).length ? { annotations } : {}) } });
    } else if (request.type === 'elicitationForm' && fields) {
      const content = Object.fromEntries(fields.flatMap((field, index) => {
        const value = String(data.get(`field:${index}`) ?? '');
        return value === '' && !field.required ? [] : [[field.name, field.type === 'boolean' ? value === 'true'
          : field.type === 'number' || field.type === 'integer' ? Number(value) : value]];
      }));
      void send({ type: 'elicitation', action: 'accept', content });
    } else if (request.type === 'elicitationUrl') void send({ type: 'elicitation', action: 'accept' });
  };
  return <form onSubmit={submit} className="grid gap-3">
    <div className="text-xs text-muted-foreground" role="status">
      {record.availability} · {record.delivery}{record.nativeApplication === 'unknown' ? ' · 是否已应用：未知' : ''}
    </div>
    <fieldset disabled={disabled} className="grid min-w-0 gap-3">
      {request.type === 'askUserQuestion' ? request.questions.map((question, index) => <fieldset key={question.question} className="grid gap-2">
        <legend className="whitespace-pre-wrap break-words font-medium">{question.header && <span className="mr-2 text-xs text-muted-foreground">{question.header}</span>}{question.question}</legend>
        {question.options.map((option) => <label key={option.label} className="flex items-start gap-2 rounded-lg border border-border/50 p-2">
          <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`answer:${index}`} value={option.label} className="mt-1" />
          <span className="min-w-0 whitespace-pre-wrap break-words"><strong className="font-medium">{option.label}</strong><small className="block text-muted-foreground">{option.description}</small>
            {option.preview !== undefined && <pre className="mt-1 whitespace-pre-wrap break-words text-xs">{option.preview}</pre>}</span>
        </label>)}
        <label htmlFor={`${id}:other:${index}`} className="text-xs text-muted-foreground">{t('questions.otherAnswer')}</label>
        <textarea id={`${id}:other:${index}`} name={`other:${index}`} rows={1} className={INPUT} />
        <label htmlFor={`${id}:notes:${index}`} className="text-xs text-muted-foreground">补充说明（可选）</label>
        <textarea id={`${id}:notes:${index}`} name={`notes:${index}`} rows={1} className={INPUT} />
      </fieldset>) : <>
        <div className="text-xs text-muted-foreground">{request.mcpServerName}</div>
        <p className="whitespace-pre-wrap break-words">{request.message}</p>
        {request.type === 'elicitationUrl' ? <>
          <p className="select-text break-all">{request.url}</p>
          <p className="text-xs text-muted-foreground">请在浏览器中完成流程；继续仅发送接受响应，不代表流程已完成。</p>
        </> : fields === null ? <p className="text-xs text-muted-foreground">此表单格式暂不支持，可拒绝或取消。</p> : fields.map((field, index) => <label key={field.name} className="grid gap-1">
          <span>{field.title}{field.required ? ' *' : ''}</span>
          {field.description && <small className="text-muted-foreground">{field.description}</small>}
          {field.values || field.type === 'boolean' ? <select name={`field:${index}`} required={field.required} className={INPUT} defaultValue="">
            <option value="" disabled={field.required}>请选择</option>
            {field.type === 'boolean' ? <><option value="true">是</option><option value="false">否</option></>
              : field.values?.map((value) => <option key={value} value={value}>{value}</option>)}
          </select> : <input name={`field:${index}`} className={INPUT} required={field.required}
            type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} step={field.type === 'integer' ? 1 : 'any'} />}
        </label>)}
      </>}
    </fieldset>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={BUTTON} disabled={disabled} onClick={() => void send(request.type === 'askUserQuestion'
        ? { type: 'askUserQuestion', answer: { action: 'decline', message: 'User declined to answer' } }
        : { type: 'elicitation', action: 'decline' })}>拒绝</button>
      {request.type !== 'askUserQuestion' && <button type="button" className={BUTTON} disabled={disabled} onClick={() => void send({ type: 'elicitation', action: 'cancel' })}>取消</button>}
      <button type="submit" className={`${BUTTON} ml-auto bg-muted`} disabled={disabled || (request.type === 'elicitationForm' && fields === null)}>
        {t(submittingId === sessionQuestionKey(record.target) ? 'questions.submitting' : 'questions.submit')}
      </button>
    </div>
    {(error || submitError) && <p role="status" className="text-xs text-destructive">{t(submitError ? 'questions.submitFailed' : 'questions.loadFailed')}</p>}
    {!confirmed && submittingId === null && <p role="status" className="text-xs text-muted-foreground">{t('questions.confirming')}</p>}
    <button type="button" className={`${BUTTON} justify-self-end`} disabled={submittingId !== null} onClick={onRefresh}>{t('questions.retry')}</button>
  </form>;
}
