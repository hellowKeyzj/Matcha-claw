import type { ReactNode } from 'react';
import { AlertCircle, Bot, MessageSquare, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function WelcomeScreen({ input }: { input?: ReactNode }) {
  const { t } = useTranslation('chat');
  return (
    <div
      data-testid="chat-welcome-screen"
      className="mx-auto flex w-full max-w-[56rem] flex-col items-center px-3 pt-8 text-center md:px-4 md:pt-12"
    >
      <div className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-border/50 bg-background text-foreground shadow-none">
        <Bot className="h-[18px] w-[18px]" />
      </div>
      <h2 className="max-w-2xl text-[2rem] font-semibold tracking-[-0.05em] text-foreground md:text-[2.35rem]">
        {t('welcome.title')}
      </h2>
      <p className="mt-2 max-w-2xl text-[14px] leading-6 text-muted-foreground md:text-[15px] md:leading-7">
        {t('welcome.subtitle')}
      </p>

      {input ? (
        <div className="mt-8 w-full">
          {input}
        </div>
      ) : null}

      <div className="mt-8 grid w-full gap-3 md:grid-cols-2">
        {[
          { icon: MessageSquare, title: t('welcome.askQuestions'), desc: t('welcome.askQuestionsDesc') },
          { icon: Sparkles, title: t('welcome.creativeTasks'), desc: t('welcome.creativeTasksDesc') },
        ].map((item, i) => (
          <div
            key={i}
            className="rounded-[1.35rem] border border-border/52 bg-background px-4 py-4 text-left shadow-none md:px-5 md:py-[18px]"
          >
            <item.icon className="mb-3 h-[18px] w-[18px] text-foreground" />
            <h3 className="font-medium text-foreground">{item.title}</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FailureScreen({ message }: { message: string | null }) {
  const { t } = useTranslation('chat');
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-start px-1 pb-20 pt-3 md:px-0 md:pt-5">
      <div className="mb-5 inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-destructive/20 bg-destructive/5 text-destructive shadow-none">
        <AlertCircle className="h-[18px] w-[18px]" />
      </div>
      <h2 className="max-w-2xl text-[1.9rem] font-semibold tracking-[-0.045em] text-foreground md:text-[2.05rem]">
        {t('status.error')}
      </h2>
      <p className="mt-2 max-w-2xl text-[14px] leading-6 text-muted-foreground md:text-[15px] md:leading-7">
        {message || t('common:status.error')}
      </p>
    </div>
  );
}
