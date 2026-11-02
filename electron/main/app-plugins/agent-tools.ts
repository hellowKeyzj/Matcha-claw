import type { AppPluginBuild, AppPluginManifest, InstalledAppPlugin } from '../../../src/types/desktop/app-plugin';
import type { ApplicationPluginOwner } from './owner';
import { AppPluginError, MAX_APP_PLUGIN_ZIP_BYTES, MAX_APP_PLUGIN_CONTENT_BYTES, MAX_APP_PLUGIN_FILE_BYTES, MAX_APP_PLUGIN_FILES, requireDigest, requireObject, requirePluginId, validateAppPluginManifest } from './package';

export const APP_PLUGIN_TOOLS = [
  { name: 'app_plugins_sdk', description: 'Create a NEW plugin development instance or reconnect using developmentId. Returns the independent SDK and private loopback connection. Never reads installed plugin source.', inputSchema: { type: 'object', properties: { developmentId: { type: 'string' } }, additionalProperties: false } },
  { name: 'app_plugins_list', description: 'List installed application plugin records. Installation is not functional verification.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'app_plugins_inspect', description: 'Inspect a supplied base64 ZIP. Does not read installed source or arbitrary local paths.', inputSchema: { type: 'object', properties: { packageBase64: { type: 'string' } }, required: ['packageBase64'], additionalProperties: false } },
  { name: 'app_plugins_build', description: 'Validate and ZIP UTF-8 files for a NEW plugin development instance. For compiled projects and binary assets use the independent SDK build/watch and direct ZIP upload.', inputSchema: { type: 'object', properties: { developmentId: { type: 'string' }, manifest: { type: 'object' }, files: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['developmentId', 'manifest', 'files'], additionalProperties: false } },
  { name: 'app_plugins_install', description: 'Install the exact latest validated development digest as a NEW plugin. Cannot replace an installed identifier. Success stops development; install only when the user intends installation.', inputSchema: { type: 'object', properties: { developmentId: { type: 'string' }, digest: { type: 'string' } }, required: ['developmentId', 'digest'], additionalProperties: false } },
  { name: 'app_plugins_status', description: 'Read a development revision/logs or installation and observed reader status. Ready and enabled are not semantic verification.', inputSchema: { type: 'object', properties: { pluginId: { type: 'string' }, developmentId: { type: 'string' } }, oneOf: [{ required: ['pluginId'] }, { required: ['developmentId'] }], additionalProperties: false } },
] as const;

export const APP_PLUGIN_SDK = {
  version: 1,
  packageName: '@matcha/app-plugins-sdk',
  languages: ['typescript', 'python', 'rust'],
  workflow: [
    'Use the plugin-making Skill in the current conversation and native Agent tools to create a NEW plugin in a workspace you choose. A manifest may contribute readers, connectors and applications together. The first validated package binds its new plugin identifier. Installed source/edit access is not provided. Native filesystem, terminal and network authorization still applies; this is trusted local code, not an OS sandbox.',
    'Call app_plugins_sdk({}) to create a development instance or pass {developmentId} to reconnect. Save its development connection privately as connection.json. Download the independent SDK with that connection Bearer token and install its local archive into your workspace using native tools. The token authenticates loopback HTTP only, not chat permissions or user approval. Never request Matcha application source or its private MCP credentials.',
    'Read the shipped README and public declarations. Use SDK init and choose --backend typescript|python|rust as needed; connected commands use --connection <connection.json>. Prepare dependencies/build tools with native Agent tools. SDK build transforms TS/TSX with esbuild, embeds UI resources and packs a validated ZIP; it is not a custom compiler. Rust is compiled for the current platform with cargo; Python uses 3.12 and optional paired pyproject.toml/uv.lock, never a development venv path.',
    'Use SDK build/dev/watch with the connection to upload ZIP bytes directly to the development instance. Connected build and the first successful watch/dev upload request the real Matcha preview; later revisions reload without stealing focus. Compilation or ZIP validation failure preserves the previous successful revision. Do not pass large binary packages through model messages.',
    'For applications use SDK status, preview, inspect, act and call against the development preview. Inspect returns opaque node ids for that snapshot; act only clicks/fills those nodes, never evaluates JavaScript. Fix build/runtime/UI errors and verify actual results. Bridge ready is not proof of a usable UI. Development preview has no caller session identity or compose capability. Readers keep their existing sandbox and require verification in their actual reader surface; declarative connectors require a real connection check, not DOM inspection.',
    'Install only when the user intends installation, using the final verified latest digest with SDK install or app_plugins_install. Installation is atomic new-only and stops the development process; the installed plugin must work independently of watch. SDK stop closes only the development instance. Exiting watch does not install or stop it. Do not overwrite an existing plugin or retry an uncertain side effect.',
  ],
  limits: { zipBytes: MAX_APP_PLUGIN_ZIP_BYTES, unpackedBytes: MAX_APP_PLUGIN_CONTENT_BYTES, fileBytes: MAX_APP_PLUGIN_FILE_BYTES, files: MAX_APP_PLUGIN_FILES },
  contracts: {
    manifest: 'Root manifest.json, schemaVersion:1. Application apiVersion:1. TypeScript builds to main CommonJS .cjs/.js. Alternatively backend:{language:"python",entry,pythonVersion:"3.12"} or backend:{language:"rust",entry,platform,arch}; main and backend are mutually exclusive. Public types and ZIP rules ship in the SDK and are used by the host itself.',
    ui: 'Self-contained HTML/JS or React/TSX. Standard MCP Apps initialize/tools/resources/host context are supported according to advertised capabilities. Matcha desktop extensions remain window.matchaApp. Installed apps with an actual composer may stage editable drafts; development previews do not advertise compose or caller session identity. Do not assume unsupported host capabilities.',
    backend: 'CommonJS activate(context) keeps the complete public SDK. Python/Rust use MCP stdio tools, progress and cancellation, with explicit Matcha reverse-model/event extensions. Credentials remain host-private. See shipped helpers for the actual protocol.',
    reader: 'Self-contained HTML, window.matchaReader.onInput/ready/error. Opaque reader isolation is unchanged; no Host API, native paths, Node or tool capability.',
    connector: 'Declarative MCP HTTP contribution only. Installation does not create authenticated connections or prove network availability.',
  },
} as const;

export interface AppPluginToolOperations {
  owner: ApplicationPluginOwner;
  sdk(developmentId?: string): unknown;
  build(developmentId: string, input: { manifest: AppPluginManifest; files: Record<string, string> }): Promise<AppPluginBuild>;
  install(developmentId: string, input: { digest: string }): Promise<InstalledAppPlugin>;
  status(pluginId: string): Promise<unknown>;
  developmentStatus(developmentId: string): unknown;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length) throw new AppPluginError('invalid_package', `${label} must be a nonempty string.`);
  return value;
}

export async function callAppPluginTool(name: string, args: unknown, operations: AppPluginToolOperations): Promise<unknown> {
  switch (name) {
    case 'app_plugins_sdk': {
      const input = requireObject(args, ['developmentId']);
      return operations.sdk(input.developmentId === undefined ? undefined : text(input.developmentId, 'developmentId'));
    }
    case 'app_plugins_list':
      requireObject(args, []);
      return operations.owner.list();
    case 'app_plugins_inspect': {
      const input = requireObject(args, ['packageBase64']);
      return operations.owner.inspect(text(input.packageBase64, 'packageBase64'));
    }
    case 'app_plugins_build': {
      const input = requireObject(args, ['developmentId', 'manifest', 'files']);
      const manifest = validateAppPluginManifest(input.manifest);
      if (!input.files || typeof input.files !== 'object' || Array.isArray(input.files)
        || Object.values(input.files).some((value) => typeof value !== 'string')) throw new AppPluginError('invalid_package', 'files must be a map of UTF-8 source strings.');
      return operations.build(text(input.developmentId, 'developmentId'), { manifest, files: input.files as Record<string, string> });
    }
    case 'app_plugins_install': {
      const input = requireObject(args, ['developmentId', 'digest']);
      requireDigest(input.digest);
      return operations.install(text(input.developmentId, 'developmentId'), { digest: input.digest });
    }
    case 'app_plugins_status': {
      const input = requireObject(args, ['pluginId', 'developmentId']);
      if (input.developmentId !== undefined) {
        requireObject(input, ['developmentId']);
        return operations.developmentStatus(text(input.developmentId, 'developmentId'));
      }
      requirePluginId(input.pluginId);
      return operations.status(input.pluginId);
    }
    default: throw new Error('Unknown app plugin tool.');
  }
}
