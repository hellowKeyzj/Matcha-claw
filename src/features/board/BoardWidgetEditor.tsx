import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { decodeBoardOperation, type BoardOperation, type BoardWidget } from '@/types/board';

type PutOperation = Extract<BoardOperation, { method: 'board.widget.put' }>;

export function BoardWidgetEditor({ widget, tabId, widgets, onClose, onSubmit }: {
  widget?: BoardWidget;
  tabId: string;
  widgets: readonly BoardWidget[];
  onClose: () => void;
  onSubmit: (operation: Extract<BoardOperation, { method: 'board.widget.put' }>) => Promise<boolean>;
}) {
  const { t } = useTranslation('chat');
  const id = useId();
  const returnFocus = useRef<HTMLElement | null>(null);
  const owner = widget?.contentOwner ?? widget?.contentKind;
  const [kind, setKind] = useState<PutOperation['content']['kind']>(owner ?? 'html');
  const [destinationTab, setDestinationTab] = useState(widget?.tabId ?? tabId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasDeclarations = kind === 'html' || kind === 'canvas-doc' || kind === 'registered';
  const knownTabs = [...new Set([tabId, ...widgets.map((item) => item.tabId)])];
  const afterWidgets = widgets.filter((item) => item.tabId === destinationTab && item.name !== widget?.name)
    .sort((left, right) => left.position - right.position);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const data = new FormData(event.currentTarget);
    const value = (key: string) => String(data.get(key) ?? '');
    const lines = (key: string) => value(key).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    setError(null);
    try {
      const name = value('name');
      const title = value('title');
      if (!widget && widgets.some((item) => item.name === name)) {
        throw new Error(t('board.editor.duplicateName', { defaultValue: 'This name already exists. Use its Replace content action or choose another name.' }));
      }
      if ([...title].length > 80) {
        throw new Error(t('board.editor.titleTooLong', { defaultValue: 'Title must be at most 80 characters.' }));
      }
      let props: unknown;
      if (kind === 'plugin' && value('props').trim()) {
        try {
          props = JSON.parse(value('props'));
        } catch {
          throw new Error(t('board.editor.invalidJson', { defaultValue: 'Plugin props must be valid JSON.' }));
        }
        if (props === null || typeof props !== 'object' || Array.isArray(props)) {
          throw new Error(t('board.editor.jsonObjectRequired', { defaultValue: 'Plugin props must be a JSON object, not an array, primitive or null.' }));
        }
        if (new TextEncoder().encode(JSON.stringify(props)).byteLength > 8192) {
          throw new Error(t('board.editor.propsTooLarge', { defaultValue: 'Plugin props must fit within 8 KiB of serialized UTF-8 JSON.' }));
        }
      }
      const source = value('source');
      if ((kind === 'html' || kind === 'registered') && new TextEncoder().encode(source).byteLength > 262144) {
        throw new Error(t('board.editor.sourceTooLarge', { defaultValue: 'HTML or registered source must fit within 256 KiB of UTF-8 text.' }));
      }
      const netOrigins = hasDeclarations ? lines('netOrigins') : [];
      const tools = hasDeclarations ? lines('tools') : [];
      if (netOrigins.length > 32 || netOrigins.some((origin) => [...origin].length > 2048)) {
        throw new Error(t('board.editor.invalidOrigins', { defaultValue: 'Use at most 32 network origins, up to 2,048 characters each.' }));
      }
      if (tools.length > 64 || tools.some((tool) => [...tool].length > 269)) {
        throw new Error(t('board.editor.invalidTools', { defaultValue: 'Use at most 64 tool names, up to 269 characters each.' }));
      }
      const after = value('after');
      const size = value('size');
      const candidate = {
        method: 'board.widget.put',
        name,
        ...(title ? { title } : {}),
        content: kind === 'html' ? { kind, html: source }
          : kind === 'mcp-app' ? { kind, viewId: value('viewId') }
            : kind === 'canvas-doc' ? { kind, docId: value('docId') }
              : kind === 'plugin' ? { kind, pluginKind: value('pluginKind'), ...(props !== undefined ? { props } : {}) }
                : { kind, contentKind: value('contentKind'), source },
        presentation: value('presentation'),
        heightMode: value('heightMode'),
        placement: {
          // Native put treats an explicit tab as a move, even when the tab is unchanged.
          ...(!widget || destinationTab !== widget.tabId ? { tabId: destinationTab } : {}),
          ...(size ? { size } : {}),
          ...(after ? { after } : {}),
        },
        ...(hasDeclarations ? { declared: { netOrigins, tools } } : {}),
      };
      let operation: PutOperation;
      try {
        operation = decodeBoardOperation(candidate) as PutOperation;
      } catch {
        throw new Error(t('board.editor.invalidOperation', { defaultValue: 'The widget contains invalid fields. Check the required fields, names, source and permission limits.' }));
      }
      setSubmitting(true);
      if (await onSubmit(operation) === true) onClose();
      else setError(t('board.editor.saveUnconfirmed', { defaultValue: 'Saving was not confirmed. Your inputs are preserved; check the board status before retrying.' }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('board.editor.saveFailed', { defaultValue: 'Could not save the widget. Your inputs are preserved.' }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <SheetContent
        showCloseButton={false}
        className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
        aria-busy={submitting}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); }}
      >
        <SheetHeader className="border-b border-border px-6 py-5 pr-16 text-left">
          <SheetTitle>{widget
            ? t('board.editor.replaceTitle', { defaultValue: 'Replace widget content' })
            : t('board.editor.createTitle', { defaultValue: 'Add widget' })}</SheetTitle>
          <SheetDescription>{t('board.editor.description', { defaultValue: 'Save content to this session’s native board. Permissions are managed by the runtime.' })}</SheetDescription>
        </SheetHeader>
        <Button type="button" variant="ghost" size="icon" className="absolute right-3 top-3" disabled={submitting} onClick={onClose}
          aria-label={t('board.editor.close', { defaultValue: 'Close editor' })}>
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
          <fieldset disabled={submitting} className="min-w-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            {widget && (
              <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                {t('board.editor.replacementNotice', { defaultValue: 'Original HTML, registered source and view/document IDs are not loaded from the snapshot. Enter replacement content. Saving creates a new revision and re-evaluates its permission grant.' })}
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${id}-name`}>{t('board.editor.name', { defaultValue: 'Widget name' })}</Label>
                <Input id={`${id}-name`} name="name" defaultValue={widget?.name ?? ''} readOnly={!!widget} required maxLength={64}
                  pattern={'[a-z0-9][a-z0-9._\\-]{0,63}'} aria-describedby={`${id}-name-hint`} autoComplete="off" spellCheck={false} placeholder="project-status" />
                <p id={`${id}-name-hint`} className="text-xs text-muted-foreground">{t('board.editor.nameHint', { defaultValue: '1–64 lowercase letters, digits, dots, underscores or hyphens; start with a letter or digit. The name cannot change during replacement.' })}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-title`}>{t('board.editor.title', { defaultValue: 'Title (optional)' })}</Label>
                <Input id={`${id}-title`} name="title" defaultValue={widget?.title ?? ''} maxLength={160} aria-describedby={`${id}-title-hint`} />
                <p id={`${id}-title-hint`} className="text-xs text-muted-foreground">{t('board.editor.titleHint', { defaultValue: 'Up to 80 characters. Leave blank to use the name or keep the existing title.' })}</p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-kind`}>{t('board.editor.kind', { defaultValue: 'Content type' })}</Label>
              <Select id={`${id}-kind`} value={kind} onChange={(event) => setKind(event.target.value as PutOperation['content']['kind'])} aria-describedby={widget ? `${id}-kind-hint` : undefined}>
                <option value="html" disabled={!!widget && owner !== 'html'}>{t('board.editor.html', { defaultValue: 'HTML' })}</option>
                <option value="mcp-app" disabled={!!widget && owner !== 'mcp-app'}>{t('board.editor.mcpApp', { defaultValue: 'MCP App view' })}</option>
                <option value="canvas-doc" disabled={!!widget && owner !== 'html'}>{t('board.editor.canvasDoc', { defaultValue: 'Canvas document' })}</option>
                <option value="plugin" disabled={!!widget && owner !== 'plugin'}>{t('board.editor.plugin', { defaultValue: 'Plugin widget' })}</option>
                <option value="registered" disabled={!!widget && owner !== 'registered'}>{t('board.editor.registered', { defaultValue: 'Registered content' })}</option>
              </Select>
              {widget && <p id={`${id}-kind-hint`} className="text-xs text-muted-foreground">{t('board.editor.kindHint', { defaultValue: 'Replacement must keep the same content owner and plugin/content kind. Remove the widget first to change them.' })}</p>}
            </div>
            {(kind === 'html' || kind === 'registered') && (
              <div key={kind} className="space-y-4">
                {kind === 'registered' && <div className="space-y-2">
                  <Label htmlFor={`${id}-contentKind`}>{t('board.editor.contentKind', { defaultValue: 'Registered content kind' })}</Label>
                  <Input id={`${id}-contentKind`} name="contentKind" defaultValue={widget?.registeredContentKind ?? ''} readOnly={!!widget} required maxLength={32}
                    pattern={'[a-z][a-z0-9\\-]{0,31}'} placeholder="a2ui" spellCheck={false} autoComplete="off" aria-describedby={`${id}-contentKind-hint`} />
                  <p id={`${id}-contentKind-hint`} className="text-xs text-muted-foreground">{t('board.editor.contentKindHint', { defaultValue: '1–32 lowercase letters, digits or hyphens; start with a letter. Its provider must be enabled.' })}</p>
                </div>}
                <div className="space-y-2">
                  <Label htmlFor={`${id}-source`}>{kind === 'html'
                    ? t('board.editor.htmlSource', { defaultValue: 'HTML source' })
                    : t('board.editor.registeredSource', { defaultValue: 'Registered source' })}</Label>
                  <Textarea id={`${id}-source`} name="source" required rows={10} maxLength={262144} className="font-mono text-xs" spellCheck={false} aria-describedby={`${id}-source-hint`} />
                  <p id={`${id}-source-hint`} className="text-xs text-muted-foreground">{t('board.editor.sourceHint', { defaultValue: 'Required, up to 256 KiB of UTF-8 text. Source is sent to the native runtime, not previewed here.' })}</p>
                </div>
              </div>
            )}
            {kind === 'mcp-app' && <div className="space-y-2">
              <Label htmlFor={`${id}-viewId`}>{t('board.editor.viewId', { defaultValue: 'MCP App view ID' })}</Label>
              <Input id={`${id}-viewId`} name="viewId" required autoComplete="off" spellCheck={false} aria-describedby={`${id}-viewId-hint`} />
              <p id={`${id}-viewId-hint`} className="text-xs text-muted-foreground">{t('board.editor.viewIdHint', { defaultValue: 'Required. Use an active native MCP App view from this session; the runtime resolves its descriptor and permissions.' })}</p>
            </div>}
            {kind === 'canvas-doc' && <div className="space-y-2">
              <Label htmlFor={`${id}-docId`}>{t('board.editor.docId', { defaultValue: 'Canvas document ID' })}</Label>
              <Input id={`${id}-docId`} name="docId" required autoComplete="off" spellCheck={false} aria-describedby={`${id}-docId-hint`} />
              <p id={`${id}-docId-hint`} className="text-xs text-muted-foreground">{t('board.editor.docIdHint', { defaultValue: 'Required. The native runtime loads this script-enabled Canvas document as HTML.' })}</p>
            </div>}
            {kind === 'plugin' && <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor={`${id}-pluginKind`}>{t('board.editor.pluginKind', { defaultValue: 'Plugin kind' })}</Label>
                <Input id={`${id}-pluginKind`} name="pluginKind" defaultValue={widget?.pluginKind ?? ''} readOnly={!!widget} required maxLength={129}
                  pattern={'[a-z0-9][a-z0-9\\-]{0,63}:[a-z0-9][a-z0-9._\\-]{0,63}'} list={`${id}-plugins`} placeholder="session:progress" spellCheck={false} autoComplete="off" aria-describedby={`${id}-pluginKind-hint`} />
                <datalist id={`${id}-plugins`}>
                  <option value="session:progress" /><option value="session:report" />
                </datalist>
                <p id={`${id}-pluginKind-hint`} className="text-xs text-muted-foreground">{t('board.editor.pluginKindHint', { defaultValue: 'Required: namespace:kind, up to 64 characters each. Lowercase letters and digits; hyphens allowed, with dots/underscores also allowed after the colon.' })}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-props`}>{t('board.editor.props', { defaultValue: 'Plugin props (JSON object)' })}</Label>
                <Textarea id={`${id}-props`} name="props" defaultValue={widget?.props ? JSON.stringify(widget.props, null, 2) : '{}'} rows={7} className="font-mono text-xs" spellCheck={false} aria-describedby={`${id}-props-hint`} />
                <p id={`${id}-props-hint`} className="text-xs text-muted-foreground">{t('board.editor.propsHint', { defaultValue: 'Optional JSON object, up to 8 KiB when serialized as UTF-8. Arrays, primitives and null are not accepted.' })}</p>
              </div>
            </div>}
            {hasDeclarations && <div className="space-y-4 border-t border-border pt-4">
              <div className="space-y-2">
                <Label htmlFor={`${id}-netOrigins`}>{t('board.editor.netOrigins', { defaultValue: 'Declared network origins' })}</Label>
                <Textarea id={`${id}-netOrigins`} name="netOrigins" defaultValue={widget?.declared?.netOrigins?.join('\n') ?? ''} rows={3} className="min-h-20 font-mono text-xs" spellCheck={false} placeholder="https://api.example.com" aria-describedby={`${id}-netOrigins-hint`} />
                <p id={`${id}-netOrigins-hint`} className="text-xs text-muted-foreground">{t('board.editor.netOriginsHint', { defaultValue: 'One exact HTTPS origin per line, without paths, credentials or wildcards. Maximum 32 origins, 2,048 characters each. Empty means no declared network access.' })}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-tools`}>{t('board.editor.tools', { defaultValue: 'Declared tool capabilities' })}</Label>
                <Textarea id={`${id}-tools`} name="tools" defaultValue={widget?.declared?.tools?.join('\n') ?? ''} rows={3} className="min-h-20 font-mono text-xs" spellCheck={false} aria-describedby={`${id}-tools-hint`} />
                <p id={`${id}-tools-hint`} className="text-xs text-muted-foreground">{t('board.editor.toolsHint', { defaultValue: 'One native tool capability per line. Maximum 64 names, 269 characters each. Declarations request permission; they do not grant it.' })}</p>
              </div>
            </div>}
            <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${id}-tabId`}>{t('board.editor.tabId', { defaultValue: 'Destination tab ID' })}</Label>
                <Input id={`${id}-tabId`} value={destinationTab} onChange={(event) => setDestinationTab(event.target.value)} required maxLength={40}
                  pattern={'[a-z0-9\\-]{1,40}'} list={`${id}-tabs`} spellCheck={false} autoComplete="off" aria-describedby={`${id}-tabId-hint`} />
                <datalist id={`${id}-tabs`}>{knownTabs.map((value) => <option key={value} value={value} />)}</datalist>
                <p id={`${id}-tabId-hint`} className="text-xs text-muted-foreground">{t('board.editor.tabIdHint', { defaultValue: 'Use an existing tab: 1–40 lowercase letters, digits or hyphens.' })}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-size`}>{t('board.editor.size', { defaultValue: 'Size' })}</Label>
                <Select id={`${id}-size`} name="size" defaultValue={widget ? '' : 'md'}>
                  {widget && <option value="">{t('board.editor.keepSize', { defaultValue: 'Keep current size' })}</option>}
                  <option value="sm">{t('board.editor.sizeSm', { defaultValue: 'Small' })}</option>
                  <option value="md">{t('board.editor.sizeMd', { defaultValue: 'Medium' })}</option>
                  <option value="lg">{t('board.editor.sizeLg', { defaultValue: 'Large' })}</option>
                  <option value="xl">{t('board.editor.sizeXl', { defaultValue: 'Extra large' })}</option>
                  <option value="full">{t('board.editor.sizeFull', { defaultValue: 'Full width' })}</option>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor={`${id}-after`}>{t('board.editor.after', { defaultValue: 'Place after widget' })}</Label>
                <Select key={destinationTab} id={`${id}-after`} name="after" defaultValue="">
                  <option value="">{widget && destinationTab === widget.tabId
                    ? t('board.editor.keepOrder', { defaultValue: 'Keep current order' })
                    : t('board.editor.appendOrder', { defaultValue: 'Append to destination tab' })}</option>
                  {afterWidgets.map((item) => <option key={item.name} value={item.name}>{item.title ? `${item.title} (${item.name})` : item.name}</option>)}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-presentation`}>{t('board.editor.presentation', { defaultValue: 'Presentation' })}</Label>
                <Select id={`${id}-presentation`} name="presentation" defaultValue={widget?.presentation ?? 'card'}>
                  <option value="card">{t('board.editor.card', { defaultValue: 'Card' })}</option>
                  <option value="full-bleed">{t('board.editor.fullBleed', { defaultValue: 'Full bleed' })}</option>
                  <option value="frameless">{t('board.editor.frameless', { defaultValue: 'Frameless' })}</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-heightMode`}>{t('board.editor.heightMode', { defaultValue: 'Height mode' })}</Label>
                <Select id={`${id}-heightMode`} name="heightMode" defaultValue={widget?.heightMode ?? 'auto'}>
                  <option value="auto">{t('board.editor.autoHeight', { defaultValue: 'Automatic' })}</option>
                  <option value="fixed">{t('board.editor.fixedHeight', { defaultValue: 'Fixed' })}</option>
                </Select>
              </div>
            </div>
          </fieldset>
          <div className="space-y-3 border-t border-border px-6 py-4">
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>{t('board.editor.cancel', { defaultValue: 'Cancel' })}</Button>
              <Button type="submit" disabled={submitting}>
                <Loader2 className={cn('h-4 w-4 animate-spin', !submitting && 'hidden')} aria-hidden="true" />
                {submitting ? t('board.editor.saving', { defaultValue: 'Saving…' }) : t('board.editor.save', { defaultValue: 'Save widget' })}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
