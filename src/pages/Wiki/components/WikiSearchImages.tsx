import { useEffect, useRef, useState, type JSX } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, ImageIcon, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { resolveWikiMarkdownImage } from '../wiki-media';
import { WikiSearchText } from './WikiSearchText';

export type WikiSearchImageHit = Readonly<{
  url: string;
  alt: string;
  sourcePath: string;
  sourceTitle: string;
  matchesQuery: boolean;
}>;

type ImageState = { kind: 'loading' } | { kind: 'ready'; src: string } | { kind: 'error' };

function SearchImage({ hit, initialSrc, thumbnail, onOpen }: Readonly<{
  hit: WikiSearchImageHit;
  initialSrc?: string;
  thumbnail?: boolean;
  onOpen?(src: string | undefined, trigger: HTMLButtonElement): void;
}>): JSX.Element {
  const { t } = useTranslation('wiki');
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ImageState>(initialSrc ? { kind: 'ready', src: initialSrc } : { kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (initialSrc && attempt === 0) return;
    let cancelled = false;
    const load = async () => {
      try {
        const src = await resolveWikiMarkdownImage(hit.url, hit.sourcePath);
        if (!cancelled) setState(src ? { kind: 'ready', src } : { kind: 'error' });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    };
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void load();
    });
    if (container.current) observer.observe(container.current);
    return () => { cancelled = true; observer.disconnect(); };
  }, [attempt, hit.sourcePath, hit.url, initialSrc]);

  const retry = () => { setState({ kind: 'loading' }); setAttempt((value) => value + 1); };
  const image = state.kind === 'ready'
    ? <img src={state.src} alt={hit.alt || hit.sourceTitle} onError={() => setState({ kind: 'error' })} className={thumbnail ? 'h-full w-full object-cover' : 'max-h-[60vh] max-w-full object-contain'} />
    : <span role="status" className="flex items-center gap-2 text-xs text-muted-foreground">{state.kind === 'loading'
      ? <><Loader2 className="h-4 w-4 animate-spin" />{t('search.imageLoading', { defaultValue: '正在加载图片…' })}</>
      : t('search.imageUnavailable', { defaultValue: '图片无法加载，请重试或打开来源检查。' })}</span>;

  return (
    <div ref={container} className={thumbnail ? 'relative flex h-[120px] items-center justify-center overflow-hidden bg-secondary/40' : 'relative flex min-h-[180px] items-center justify-center bg-secondary/20 p-4'}>
      {onOpen ? <button type="button" onClick={(event) => onOpen(state.kind === 'ready' ? state.src : undefined, event.currentTarget)} aria-label={t('search.previewImage', { defaultValue: '预览图片：{{caption}}', caption: hit.alt || hit.sourceTitle })} className="flex h-full w-full items-center justify-center p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">{image}</button> : image}
      {state.kind === 'error' ? <Button type="button" size="sm" variant="outline" onClick={retry} className="absolute bottom-2 right-2">{t('search.retryImage', { defaultValue: '重试加载' })}</Button> : null}
    </div>
  );
}

export function WikiSearchImages({ images, tokens, disabled, onOpenSource }: Readonly<{
  images: readonly WikiSearchImageHit[];
  tokens: readonly string[];
  disabled: boolean;
  onOpenSource?(pagePath: string, imageSrc: string): Promise<void>;
}>): JSX.Element {
  const { t } = useTranslation('wiki');
  const [showSupporting, setShowSupporting] = useState(false);
  const [selected, setSelected] = useState<Readonly<{ hit: WikiSearchImageHit; src?: string }> | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [sourceState, setSourceState] = useState<'idle' | 'opening' | 'error'>('idle');
  const [sourceError, setSourceError] = useState('');
  const matchingCount = images.filter((image) => image.matchesQuery).length;
  const supportingCount = images.length - matchingCount;
  const visibleImages = showSupporting ? images : images.filter((image) => image.matchesQuery);

  const openSource = async () => {
    if (!selected || !onOpenSource) return;
    setSourceState('opening');
    try {
      await onOpenSource(selected.hit.sourcePath, selected.hit.url);
      setSelected(null);
      setSourceState('idle');
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : '');
      setSourceState('error');
    }
  };

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-5 pt-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><ImageIcon className="h-3.5 w-3.5" />{t('search.imageMatchCount', { defaultValue: '匹配图片 {{count}}', count: matchingCount })}</span>
        {supportingCount > 0 ? <button type="button" aria-expanded={showSupporting} onClick={() => setShowSupporting((value) => !value)} className="underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{showSupporting
          ? t('search.hideSupporting', { defaultValue: '收起支持图片' })
          : t('search.showAllSupporting', { defaultValue: '显示支持图片（{{count}}）', count: supportingCount })}</button> : null}
      </div>
      {visibleImages.length > 0 ? (
        <div className="max-h-[40%] shrink-0 overflow-y-auto px-5 py-3">
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            {visibleImages.map((hit) => (
              <article key={hit.url} className="overflow-hidden rounded-xl border border-border/70 bg-card">
                <SearchImage hit={hit} thumbnail onOpen={(src, trigger) => { triggerRef.current = trigger; setSelected({ hit, src }); setSourceState('idle'); }} />
                <div className="flex h-16 flex-col p-2">
                  <div className="line-clamp-2 text-xs"><WikiSearchText text={hit.alt || t('search.noCaption', { defaultValue: '暂无图片说明' })} tokens={tokens} /></div>
                  <div className="mt-auto truncate text-[11px] text-muted-foreground">{hit.sourceTitle}</div>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}
      <Dialog.Root open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
          <Dialog.Content onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus(); }} className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[90vw] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b px-5 py-3">
              <div className="min-w-0">
                <Dialog.Title className="line-clamp-3 text-sm font-medium">{selected?.hit.alt || t('search.noCaption', { defaultValue: '暂无图片说明' })}</Dialog.Title>
                <Dialog.Description className="mt-1 truncate text-xs text-muted-foreground">{t('search.fromSource', { defaultValue: '来自：{{source}}', source: selected?.hit.sourceTitle })}</Dialog.Description>
              </div>
              <Dialog.Close asChild><Button type="button" size="icon" variant="ghost" aria-label={t('search.closeImage', { defaultValue: '关闭图片预览' })}><X className="h-4 w-4" /></Button></Dialog.Close>
            </div>
            <div className="min-h-0 overflow-auto">{selected ? <SearchImage key={selected.hit.url} hit={selected.hit} initialSrc={selected.src} /> : null}</div>
            <div className="flex flex-wrap items-center justify-end gap-3 border-t px-5 py-3">
              {sourceState === 'error' ? <p role="alert" className="mr-auto text-sm text-destructive">{sourceError || t('search.sourceOpenFailed', { defaultValue: '无法打开原始来源，请检查来源文件是否仍在知识库中后重试。' })}</p> : null}
              {!onOpenSource ? <p className="mr-auto text-xs text-muted-foreground">{t('search.sourceUnavailable', { defaultValue: '当前无法定位原始来源，请从来源列表打开原文。' })}</p> : null}
              <Button type="button" size="sm" onClick={() => { void openSource(); }} disabled={disabled || sourceState === 'opening' || !onOpenSource}>
                {sourceState === 'opening' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
                {t('search.jumpToSource', { defaultValue: '定位原始来源' })}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
