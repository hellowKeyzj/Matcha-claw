/**
 * Renderer-side replacement for the subset of Electron's preload API that the
 * upstream GenOffice preload uses. Inside a MatchaClaw app frame there is no
 * Electron preload; IPC is routed through the plugin tool bridge instead.
 */
import type { AppToolResult } from '@matcha/app-plugins-sdk';
import { appApi } from '../documents/client';

type IpcListener = (event: unknown, ...args: unknown[]) => void;

export const editorId = crypto.randomUUID();

const app = document.documentElement.dataset.officeApp;
if (!app || !['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'].includes(app)) throw new Error('Office editor identity is missing.');
const TOPIC_PREFIX = `office.${app}.`;
const IPC_TOOL = `office_${app}_ipc`;
const listeners = new Map<string, Set<IpcListener>>();
const applicationOpens: unknown[] = [];
let applicationOpenHandler: ((data: unknown) => void) | undefined;
let subscribed = false;

export function onApplicationOpen(handler: (data: unknown) => void): () => void {
  if (applicationOpenHandler) throw new Error('The Office application-open handler is already registered.');
  applicationOpenHandler = handler;
  ensureSubscription();
  for (const data of applicationOpens.splice(0)) handler(data);
  return () => { if (applicationOpenHandler === handler) applicationOpenHandler = undefined; };
}

function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  appApi().subscribe(({ topic, data }) => {
    if (topic === 'application.open') {
      if (applicationOpenHandler) applicationOpenHandler(data);
      else {
        if (applicationOpens.length >= 64) throw new Error('Too many pending Office application opens.');
        applicationOpens.push(data);
      }
      return;
    }
    if (!topic.startsWith(TOPIC_PREFIX)) return;
    const event = data as { payload?: unknown; editorId?: string } | null;
    if (event?.editorId && event.editorId !== editorId) return;
    const channel = topic.slice(TOPIC_PREFIX.length);
    const payload = event?.payload;
    for (const listener of listeners.get(channel) ?? []) listener({ sender: {} }, payload);
  });
}

function textOf(result: AppToolResult, fallback: string): string {
  const item = result.content?.find((entry) => entry.type === 'text');
  return typeof item?.text === 'string' && item.text ? item.text : fallback;
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const api = appApi();
  const response = await api.call(IPC_TOOL, { channel, arguments: args, editorId });
  if (response.isError) throw new Error(textOf(response, `Office IPC ${channel} failed.`));
  return (response.structuredContent as { result?: unknown } | undefined)?.result;
}

export const contextBridge = {
  exposeInMainWorld(key: string, value: unknown): void {
    (window as unknown as Record<string, unknown>)[key] = value;
  }
};

export const ipcRenderer = {
  invoke,
  send(channel: string, ...args: unknown[]): void {
    void invoke(channel, ...args).catch((error: unknown) => {
      window.dispatchEvent(new ErrorEvent('error', { message: error instanceof Error ? error.message : 'Office event delivery failed.', error }));
    });
  },
  on(channel: string, listener: IpcListener): (() => void) {
    ensureSubscription();
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    set.add(listener);
    return () => set?.delete(listener);
  },
  removeListener(channel: string, listener: IpcListener): void {
    listeners.get(channel)?.delete(listener);
  },
  once(channel: string, listener: IpcListener): void {
    const unsubscribe = ipcRenderer.on(channel, (event, ...args) => {
      unsubscribe();
      listener(event, ...args);
    });
  }
};

export const webFrame = {
  isWordMisspelled: (): boolean => false,
  getWordSuggestions: (): string[] => []
};

export const webUtils = {
  getPathForFile: (): string => ''
};
