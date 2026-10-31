import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import { appToolName, type AppToolResult, type AppWebviewApi } from '../../../../src/types/desktop/app-plugin-sdk';
import { t } from './i18n';

type IncomingToolResult = Omit<AppToolResult, 'structuredContent'> & { readonly structuredContent?: unknown };
type ToolUpdate =
  | { kind: 'document'; documentId: string; layerId?: string }
  | { kind: 'completed' }
  | { kind: 'failed'; error: string };

let connected: AppWebviewApi | undefined;
let external = false;
// Updates only bridge connect → Editor subscription; they are discarded on delivery.
let initialToolResults: { document?: ToolUpdate; error?: ToolUpdate } | undefined;

export function isExternalApp(): boolean { return external; }

export async function connectApp(): Promise<void> {
  const native = (window as Window & { matchaApp?: AppWebviewApi }).matchaApp;
  if (native) { connected = native; return; }
  if (window.parent === window) throw new Error(t('请从 Matcha 或支持 MCP Apps 的客户端打开设计工作台。'));
  const client = new App({ name: t('Matcha 设计'), version: '1.0.4' }, {}, { autoResize: false, strict: true });
  const listeners = new Set<Parameters<AppWebviewApi['subscribe']>[0]>();
  initialToolResults = {};
  client.ontoolresult = (result) => {
    let update: ToolUpdate;
    try {
      const content = resultContent(result);
      const document = content?.document;
      if (document === undefined) update = { kind: 'completed' };
      else {
        if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error(t('宿主返回了无效的业务结果。'));
        const id = (document as Record<string, unknown>).id;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error(t('宿主返回了无效的业务结果。'));
        const layerId = content?.layerId;
        if (layerId !== undefined && (typeof layerId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(layerId))) throw new Error(t('宿主返回了无效的业务结果。'));
        update = { kind: 'document', documentId: id, ...(typeof layerId === 'string' ? { layerId } : {}) };
      }
    } catch (cause) { update = { kind: 'failed', error: errorMessage(cause) }; }
    if (initialToolResults) {
      if (update.kind === 'failed') initialToolResults.error = update;
      else if (update.kind === 'document') initialToolResults = { document: update };
    }
    for (const listener of listeners) listener({ topic: 'tool.result', data: update });
  };
  await client.connect(new PostMessageTransport(window.parent, window.parent), { timeout: 10_000 });
  external = true;
  connected = {
    pluginId: 'matcha.design',
    context: {},
    async listSessionMedia() { return { scope: 'loaded-window', items: [] }; },
    async readSessionMedia() { throw new Error(t('当前客户端不支持读取会话媒体。')); },
    async writeClipboardImage() { throw new Error(t('当前客户端不支持复制图片，请使用下载原图。')); },
    async compose(request) {
      const content: Parameters<App['sendMessage']>[0]['content'] = [{ type: 'text', text: request.text }];
      for (const attachment of request.attachments ?? []) {
        content.push(attachment.mimeType.startsWith('image/')
          ? { type: 'image', data: attachment.data, mimeType: attachment.mimeType }
          : { type: 'resource', resource: { uri: `attachment:///${encodeURIComponent(attachment.name)}`, mimeType: attachment.mimeType, blob: attachment.data } });
      }
      if (request.context) content.push({ type: 'text', text: `${request.context.name}\n${request.context.text}` });
      const result = await client.sendMessage({ role: 'user', content });
      if (result.isError) throw new Error(t('客户端未接受添加到对话的请求。'));
    },
    async call(name, arguments_ = {}) {
      const result = await client.callServerTool({ name: appToolName('matcha.design', name), arguments: { ...arguments_ } }, name === 'generate' ? { timeout: 30 * 60_000 } : undefined);
      return { ...result, structuredContent: structuredContent(result) };
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  await client.sendSizeChanged({ height: 720 });
  window.addEventListener('pagehide', () => { initialToolResults = undefined; listeners.clear(); void client.close(); }, { once: true });
}

export function subscribeToolResults(listener: (update: ToolUpdate) => void): () => void {
  const unsubscribe = app().subscribe((event) => {
    if (event.topic === 'tool.result') listener(event.data as ToolUpdate);
  });
  const pending = initialToolResults;
  initialToolResults = undefined;
  if (pending?.document) listener(pending.document);
  if (pending?.error) listener(pending.error);
  return unsubscribe;
}

export class ToolError extends Error {
  constructor(message: string, readonly code?: string, readonly data?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'ToolError';
  }
}

export function app(): AppWebviewApi {
  if (!connected) throw new Error(t('设计插件尚未连接宿主，请重新打开。'));
  return connected;
}

function structuredContent(result: IncomingToolResult): AppToolResult['structuredContent'] {
  const content = result.structuredContent;
  if (content === undefined) return undefined;
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error(t('宿主返回了无效的业务结果。'));
  return content as NonNullable<AppToolResult['structuredContent']>;
}

function resultContent(result: IncomingToolResult): AppToolResult['structuredContent'] {
  const content = structuredContent(result);
  if (result.isError) {
    const message = content?.error;
    const code = content?.code;
    throw new ToolError(
      typeof message === 'string' ? message : result.content.map((part) => part.text).filter(Boolean).join('\n') || t('操作失败'),
      typeof code === 'string' ? code : undefined,
      content,
    );
  }
  return content;
}

export async function call<T>(name: string, args: object = {}): Promise<T> {
  const content = resultContent(await app().call(name, args as Record<string, unknown>));
  if (!content) throw new Error(t('插件未返回有效业务结果。'));
  return content as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fileData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error ?? new Error(t('无法读取图片')));
    reader.readAsDataURL(file);
  });
}

export function download(url: string, name: string, release?: () => void): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  try {
    anchor.click();
    if (release) setTimeout(release, 60_000);
  } catch (cause) { release?.(); throw cause; }
  finally { anchor.remove(); }
}
