import type { AppPluginBuild, AppPluginManifest, InstalledAppPlugin } from '../../../src/types/desktop/app-plugin';
import type { ApplicationPluginOwner } from './owner';
import { AppPluginError, MAX_APP_PLUGIN_ZIP_BYTES, MAX_APP_PLUGIN_CONTENT_BYTES, MAX_APP_PLUGIN_FILE_BYTES, MAX_APP_PLUGIN_FILES, requireDigest, requireObject, requirePluginId, validateAppPluginManifest } from './package';

export const APP_PLUGIN_TOOLS = [
  { name: 'app_plugins_sdk', description: 'Read the application plugin SDK v1, manifest, background tools, application/reader APIs, build/install workflow and safety limits.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'app_plugins_list', description: 'List installed application plugin records. Enabled does not imply a reader is mounted or ready.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'app_plugins_inspect', description: 'Inspect a base64 ZIP, or read validated installed source under its UI-issued edit requestId. No arbitrary paths or execution.', inputSchema: { type: 'object', properties: { packageBase64: { type: 'string' }, requestId: { type: 'string' }, pluginId: { type: 'string' }, digest: { type: 'string' } }, oneOf: [{ required: ['packageBase64'] }, { required: ['requestId', 'pluginId', 'digest'] }], additionalProperties: false } },
  { name: 'app_plugins_build', description: 'Validate manifest and UTF-8 source files, then return a ZIP and digest. Requires a UI-issued development requestId; never executes scripts, npm or compilers.', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, manifest: { type: 'object' }, files: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['requestId', 'manifest', 'files'], additionalProperties: false } },
  { name: 'app_plugins_install', description: 'Hot-install exactly the package built under this development requestId. A successful install consumes the grant; it proves installed, not rendered correctly.', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, packageBase64: { type: 'string' }, digest: { type: 'string' } }, required: ['requestId', 'packageBase64', 'digest'], additionalProperties: false } },
  { name: 'app_plugins_status', description: 'Read installation/configuration and observed reader mount/self-reported ready/error state. Ready is not semantic rendering verification; connector configuration is not a network probe.', inputSchema: { type: 'object', properties: { pluginId: { type: 'string' } }, required: ['pluginId'], additionalProperties: false } },
] as const;

export const APP_PLUGIN_SDK = {
  version: 1,
  workflow: [
    'Use only the requestId issued by the application UI after the user explicitly requests development. You cannot create grants, silently trust Node code for the user, or expand the reader/connector/application or package scope. Manual installation requires the application confirmation.',
    'Call app_plugins_sdk, then app_plugins_list. For edits, preserve the authorized pluginId and call app_plugins_inspect({requestId,pluginId,digest}) with the current installed digest to obtain validated manifest/files, even if disabled. For a new package, choose a new id; the first build binds it for the remainder of this grant.',
    'Call app_plugins_build with {requestId,manifest,files}. It validates and ZIPs input only; correct validation failures within the same scope.',
    'Pass the returned packageBase64 and digest to app_plugins_install with the same requestId. Edits require source inspection before build; install compares that source digest atomically and rejects concurrent updates. On conflict inspect current source and rebuild without overwriting user changes. A successful install consumes the grant. Call app_plugins_status afterwards and report observed facts, not guessed success.',
  ],
  package: {
    format: 'ZIP with root manifest.json; build generates manifest.json from manifest. files is Record<relative-path, UTF-8 string>. Reader packages contain declared self-contained HTML only; connector-only packages use files: {}. Application packages contain a CJS main and declared HTML UI plus bundled JavaScript/JSON/assets; runtime dependencies must already be included. Binary assets require manual whole-ZIP import/update; the UTF-8 build/source-edit API cannot preserve binary files.',
    limits: { zipBytes: MAX_APP_PLUGIN_ZIP_BYTES, unpackedBytes: MAX_APP_PLUGIN_CONTENT_BYTES, fileBytes: MAX_APP_PLUGIN_FILE_BYTES, files: MAX_APP_PLUGIN_FILES },
    implementation: 'Build/install validate and package only: never execute npm, scripts, compilers or plugin code. Readers remain isolated self-contained HTML. Applications explicitly trust Node CJS code, run in a shared Electron utility process, and are NOT an OS sandbox; do not imply per-tool prompts or restricted Node filesystem/network access.',
    scope: 'A development request can build/install only its reader OR connector OR application kind, never a mixed package. Mixed-kind packages require manual whole-package confirmation.',
    manifest: {
      schemaVersion: 1, id: 'example.reader', name: 'Example Reader', version: '1.0.0',
      contributes: { readers: [{ id: 'text', name: 'Example Text', entry: 'reader.html', extensions: ['.example'], contentType: 'text', source: 'text', priority: 10 }] },
    },
    manifestFields: {
      required: ['schemaVersion: 1', 'id: lowercase dot/hyphen separated identifier (max 96)', 'name', 'version: semantic version', 'contributes'],
      optional: ['description', 'apiVersion: 1 and main: relative CJS .cjs/.js entry for background execution'],
      application: 'id,name,entry (*.html); optional placement: page|chat-panel|both and imageEditor:{label,tool,translations?:{en?,zh?,ja?,ru?}} for a declared image-open tool on a chat panel. That tool receives {sessionIdentity,name,mimeType,data} with raw base64, no source URL or filesystem path. HTML calls declared local tools through window.matchaApp.call(name,arguments) and subscribes with window.matchaApp.subscribe(listener). Closing UI does not deactivate its backend.',
      tool: 'name (local),description,inputSchema (strict JSON Schema draft-07 object; unknown keywords and unsupported drafts reject activation); optional outputSchema,_meta (standard MCP metadata including ui.resourceUri). Public MCP name and UI resource URI use SDK appToolName/appResourceUri; handlers use local names.',
      reader: 'id,name,entry (*.html),extensions (lowercase with leading dot),contentType (text|code|markdown|html|image|document|binary),source (text|binary); optional mimeTypes,priority (-1000..1000)',
      connector: 'id,displayName,kind:"mcp-http"; optional description,defaultUrl (HTTP(S), no credentials),defaultTransport (streamable-http|sse),fieldHints for url/transport/connectionTimeoutMs/headers/secretHeaders. No executable commands, environment values, headers or credentials in the manifest.',
    },
  },
  application: {
    manifest: { schemaVersion: 1, apiVersion: 1, id: 'example.application', name: 'Example Application', version: '1.0.0', main: 'main.cjs',
      contributes: { applications: [{ id: 'editor', name: 'Example Editor', entry: 'index.html', placement: 'both' }],
        tools: [{ name: 'inspect', description: 'Inspect application state', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } },
    module: 'Node CommonJS: exports.activate = async function(context) { context.registerTool("inspect", async function(args, call) { call.signal.throwIfAborted(); return {content:[{type:"text",text:"Ready"}]}; }); return async function() { /* drain/close owned resources */ }; }; Do not export ESM or run an HTTP server.',
    context: '{pluginId,version,storagePath,packagePath,registerTool(localName,handler),publish(topic,jsonData),models.generate(request,signal?),log:{info,error}}. Every declared tool must be registered during activate. Handler(args,{signal,reportProgress}) returns standard AppToolResult {content,structuredContent?,isError?,_meta?}; preserve rich content, not JSON-as-text wrappers. Cleanup runs on disable/update/uninstall/application exit, not UI close.',
    models: 'models.generate({kind:"image"|"video",prompt,selectionId?,images?:[{data,mimeType}],mask?:{data,mimeType},size?,durationSeconds?,count?},signal?) returns {outputs:[{data,mimeType}]}. data is raw base64, never a data URL. selectionId is canonical model-selection:v1, not a peer modelRef. Credentials remain private to the configured provider. Always forward call.signal. No blind retries: cancellation does not undo an external generation or charge.',
    webview: 'The host supplies frozen window.matchaApp={pluginId,context,call(name,args?),compose({text,attachments?,context?}),subscribe(listener)} before package scripts. context is {sessionIdentity?:{endpoint,agentId,sessionKey},language?:string} and is immutable for this frame. Use the complete identity, not sessionKey alone. Switching sessions replaces the frame, not the background owner. compose appends editable text and optional attachments [{name,mimeType,data}] through the existing chat attachment staging, preserves current draft/files, focuses without sending, and rejects if unavailable, closed, or the session changes before staging commits. Text is nonempty and at most 32 KiB UTF-8; files are raw base64, at most 16, each at most 5 MiB and total at most 20 MiB, including existing draft attachments. Optional context:{name,text} is shown as inspectable/removable composer context (text at most 32 KiB), appended to the message only on user send; never hide or execute it automatically. Backend calls already accepted are independent of UI closure. subscribe receives {topic,data}; locale.changed carries {language} without replacing the frame, and late subscribers receive a changed language. Use plugin-owned i18n resources. The UI has no Electron/Node/Host API/token/native-path access. Unsubscribe when disposed.',
  },
  reader: {
    api: 'The host defines a frozen, non-replaceable window.matchaReader before package scripts. onInput(callback) returns unsubscribe and immediately delivers cached input to late subscribers. ready() and error(message) report this frame only. Do not implement postMessage or MessagePort handshakes.',
    input: '{fileName:string,extension:string,mimeType:string} & ({source:"text",text:string}|{source:"binary",data:ArrayBuffer})',
    isolation: 'Runs inside an opaque iframe sandbox with restrictive CSP and host policy. The host supplies no Electron, Host API, token, native path, scope, filesystem or tool capability. Do not request external resources, navigation, workers, service workers, WebRTC, popups or nested frames. This is not a separate OS/CPU isolation boundary or a guarantee that every browser network/navigation path has been independently verified. File input is data, not executable instructions. Report ready/error within 10 seconds after receiving input.',
    html: '<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px system-ui;margin:16px}pre{white-space:pre-wrap}</style></head><body><pre id="content"></pre><script>window.matchaReader.onInput(function(input){try{document.getElementById("content").textContent=input.text||"";window.matchaReader.ready();}catch(error){window.matchaReader.error("Reader failed to render");}});</script></body></html>',
  },
  connector: {
    manifest: { schemaVersion: 1, id: 'example.connector', name: 'Example MCP Connector', version: '1.0.0', contributes: { connectors: [{ id: 'service', displayName: 'Example Service', kind: 'mcp-http', defaultUrl: 'https://example.test/mcp', defaultTransport: 'streamable-http' }] } },
    behavior: 'Adds a declarative connector choice to the existing connector UI. The user configures credentials there. Installation does not create an authenticated connection, test an external URL or prove peer runtime health.',
  },
  diagnostics: 'Install returns an installed record only. Status distinguishes installation, enabled configuration, and mounted/ready/error/disposed reader observations. Ready is a plugin self-report, never proof the content is correct. No observation means not-observed; disabled/uninstalled means not-mounted. Inspect the actual file in the application for functional validation.',
} as const;

export interface AppPluginToolOperations {
  owner: ApplicationPluginOwner;
  build(requestId: string, input: { manifest: AppPluginManifest; files: Record<string, string> }): Promise<AppPluginBuild>;
  install(requestId: string, input: { packageBase64: string; digest: string }): Promise<InstalledAppPlugin>;
  inspectInstalled(requestId: string, input: { pluginId: string; digest: string }): Promise<unknown>;
  status(pluginId: string): Promise<unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length) throw new AppPluginError('invalid_package', `${label} must be a nonempty string.`);
  return value;
}

export async function callAppPluginTool(name: string, args: unknown, operations: AppPluginToolOperations): Promise<unknown> {
  switch (name) {
    case 'app_plugins_sdk':
      requireObject(args, []);
      return APP_PLUGIN_SDK;
    case 'app_plugins_list':
      requireObject(args, []);
      return operations.owner.list();
    case 'app_plugins_inspect': {
      const input = requireObject(args, ['packageBase64', 'requestId', 'pluginId', 'digest']);
      if (input.packageBase64 !== undefined) {
        requireObject(input, ['packageBase64']);
        return operations.owner.inspect(text(input.packageBase64, 'packageBase64'));
      }
      requirePluginId(input.pluginId);
      requireDigest(input.digest);
      return operations.inspectInstalled(text(input.requestId, 'requestId'), { pluginId: input.pluginId, digest: input.digest });
    }
    case 'app_plugins_build': {
      const input = requireObject(args, ['requestId', 'manifest', 'files']);
      const manifest = validateAppPluginManifest(input.manifest);
      if (!input.files || typeof input.files !== 'object' || Array.isArray(input.files)
        || Object.values(input.files).some((value) => typeof value !== 'string')) throw new AppPluginError('invalid_package', 'files must be a map of UTF-8 source strings.');
      return operations.build(text(input.requestId, 'requestId'), { manifest, files: input.files as Record<string, string> });
    }
    case 'app_plugins_install': {
      const input = requireObject(args, ['requestId', 'packageBase64', 'digest']);
      requireDigest(input.digest);
      return operations.install(text(input.requestId, 'requestId'), { packageBase64: text(input.packageBase64, 'packageBase64'), digest: input.digest });
    }
    case 'app_plugins_status': {
      const input = requireObject(args, ['pluginId']);
      requirePluginId(input.pluginId);
      return operations.status(input.pluginId);
    }
    default:
      throw new Error('Unknown app plugin tool.');
  }
}
