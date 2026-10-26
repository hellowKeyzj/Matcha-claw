import type { ReactNode } from 'react';
import { AlertCircle, MessageSquareText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function WelcomeScreen({ input }: { input: ReactNode }) {
  const { t } = useTranslation('chat');
  return (
    <section
      data-testid="chat-welcome-screen"
      className="mx-auto my-auto w-full min-w-0 max-w-[44rem] py-8 text-left"
    >
      <div className="mb-7 flex items-center gap-2.5 text-foreground">
        <MessageSquareText aria-hidden="true" className="h-6 w-6" strokeWidth={1.5} />
        <span className="text-sm font-semibold tracking-[-0.01em]">MatchaClaw</span>
      </div>
      <h2 className="max-w-xl text-balance text-[2rem] font-semibold leading-tight tracking-[-0.035em] text-foreground md:text-[2.25rem]">
        {t('welcome.title')}
      </h2>
      <div className="mt-7 w-full">{input}</div>
    </section>
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
