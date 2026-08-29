import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RETAINED_EVENT_CHANNELS,
  RETAINED_INVOKE_CHANNELS,
  RETAINED_ONCE_CHANNELS,
} from '../../electron/preload/ipc-contract';

const exposedElectronApi = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((name: string, api: Record<string, unknown>) => {
      if (name === 'electron') exposedElectronApi.value = api;
    }),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  webUtils: {
    getPathForFile: vi.fn(),
  },
}));

function exportedNames(sourceText: string): string[] {
  const source = ts.createSourceFile('source.ts', sourceText, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if ('name' in statement && statement.name && ts.isIdentifier(statement.name)) names.push(statement.name.text);
  }
  return names.sort();
}

describe('unchanged renderer public API boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    exposedElectronApi.value = null;
  });

  it('keeps src/lib/host-api named exports unchanged for existing renderer clients', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'lib', 'host-api.ts'), 'utf8');

    expect(exportedNames(source)).toEqual([
      'FilePreviewDirEntry',
      'FilePreviewError',
      'FilePreviewListDirResult',
      'FilePreviewStatResult',
      'FileThumbnailResult',
      'HostApiResponseDecoder',
      'HostSessionAbortResult',
      'HostSessionCatalogItem',
      'HostSessionLoadResult',
      'HostSessionModelSelectionResult',
      'HostSessionPromptResult',
      'HostSessionWindowResult',
      'OpenClawCliCommandPayload',
      'OpenClawStatusPayload',
      'OpenClawToolPermissionMode',
      'OpenClawToolPermissionModePayload',
      'ReadBinaryFileResult',
      'ReadTextFileResult',
      'StagedFilePayload',
      'WorkspaceFileContext',
      'WriteTextFileResult',
      'getHostApiBase',
      'hostApiFetch',
      'hostApiFetchDecoded',
      'hostCapabilitiesList',
      'hostCapabilityDescribe',
      'hostFileListDir',
      'hostFileReadBinary',
      'hostFileReadText',
      'hostFileStageBuffer',
      'hostFileStagePaths',
      'hostFileStat',
      'hostFileThumbnail',
      'hostFileThumbnails',
      'hostFileWriteText',
      'hostOpenClawGetCliCommand',
      'hostOpenClawGetConfigDir',
      'hostOpenClawGetDir',
      'hostOpenClawGetSkillsDir',
      'hostOpenClawGetStatus',
      'hostOpenClawGetSubagentTemplate',
      'hostOpenClawGetSubagentTemplateCatalog',
      'hostOpenClawGetTaskWorkspaceDirs',
      'hostOpenClawGetToolPermissionMode',
      'hostOpenClawGetWorkspaceDir',
      'hostOpenClawIsReady',
      'hostOpenClawSetToolPermissionMode',
      'hostRuntimeAdapterInstancesList',
      'hostRuntimeAdaptersList',
      'hostRuntimeConnectorConnect',
      'hostRuntimeConnectorDisconnect',
      'hostRuntimeConnectorsList',
      'hostRuntimeEndpointsList',
      'hostSessionAbort',
      'hostSessionApprovals',
      'hostSessionArchive',
      'hostSessionDelete',
      'hostSessionList',
      'hostSessionLoad',
      'hostSessionNew',
      'hostSessionPatch',
      'hostSessionPrompt',
      'hostSessionRename',
      'hostSessionResolveApproval',
      'hostSessionResume',
      'hostSessionState',
      'hostSessionSwitch',
      'hostSessionUnarchive',
      'hostSessionUpdateStatus',
      'hostSessionWindowFetch',
      'hostUvCheck',
      'hostUvInstallAll',
      'hostWorkspaceMediaThumbnail',
      'resolveHostApiBase',
      'resolveSingleCapabilityScope',
    ]);
  });

  it('keeps the preload electron surface and retained channel shape unchanged', async () => {
    await import('../../electron/preload/index');

    expect(Object.keys(exposedElectronApi.value ?? {}).sort()).toEqual([
      'getPathForFile',
      'ipcRenderer',
      'isDev',
      'openExternal',
      'platform',
      'showAppLogsDirectory',
      'writeFleetCredential',
    ]);
    expect(Object.keys((exposedElectronApi.value?.ipcRenderer ?? {}) as Record<string, unknown>).sort()).toEqual([
      'invoke',
      'off',
      'on',
      'once',
    ]);
    expect(RETAINED_INVOKE_CHANNELS).toEqual([
      'hostapi:fetch',
      'hostapi:abort',
      'hostapi:base-url',
      'gateway:status',
      'app:version',
      'app:name',
      'app:platform',
      'window:minimize',
      'window:maximize',
      'window:close',
      'window:isMaximized',
      'window:setRightDockWidth',
      'shell:openExternal',
      'shell:openResourcePath',
      'shell:openChromeExtensions',
      'shell:showAppLogsDirectory',
      'shell:showItemInFolder',
      'shell:openPath',
      'dialog:open',
      'dialog:save',
      'dialog:message',
      'dialog:stageOpenAttachments',
      'dialog:stageDroppedAttachments',
      'dialog:stageRendererBufferAttachment',
      'dialog:releaseStagedAttachments',
      'dialog:readSelectedTextFile',
      'dialog:readSkillImport',
      'dialog:writeSelectedTextFile',
      'update:status',
      'update:version',
      'update:check',
      'update:download',
      'update:install',
      'update:setChannel',
      'diagnostics:exportArchive',
      'fleet:writeCredential',
      'settings:splitProxyIntent',
      'providers:storeAccount',
      'providers:validateApiKey',
      'providers:deleteAccount',
      'providers:startOAuth',
      'providers:submitOAuthCode',
      'providers:cancelOAuth',
    ]);
    expect(RETAINED_EVENT_CHANNELS).toEqual([
      'navigate',
      'host:event',
      'update:status-changed',
      'update:checking',
      'update:available',
      'update:not-available',
      'update:progress',
      'update:downloaded',
      'update:error',
    ]);
    expect(RETAINED_ONCE_CHANNELS).toEqual(RETAINED_EVENT_CHANNELS);
  });
});
