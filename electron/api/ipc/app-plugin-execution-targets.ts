import { ipcMain, type BrowserWindow } from 'electron';
import type { AppTeam } from '../../../sdk/app-plugins/src/execution';
import { validateRuntimeScope } from '../../../src/types/desktop/runtime-address';
import { AppPluginError, requireObject } from '../../main/app-plugins/package';

const CHANNEL = 'app-plugins:execution-teams';
const MAX_TEAMS = 1024;
const MAX_BYTES = 1024 * 1024;

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !value.includes('\0');
}

function readTeams(value: unknown): readonly AppTeam[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_TEAMS) throw new Error('Invalid team directory size.');
  const ids = new Set<string>();
  for (const entry of value) {
    const team = requireObject(entry, ['teamId', 'name', 'scope', 'packagePath', 'sourceType']);
    const scope = requireObject(team.scope, ['kind', 'endpoint', 'agentId']);
    if (!text(team.teamId) || !text(team.name) || !text(team.packagePath)
      || (team.sourceType !== 'teamskill' && team.sourceType !== 'manual')
      || (scope.kind !== 'runtime-instance' && scope.kind !== 'agent')
      || validateRuntimeScope(scope) !== null
      || !Object.values(scope.endpoint as object).every(text)
      || (scope.kind === 'agent' && !text(scope.agentId)) || ids.has(team.teamId)) {
      throw new Error('Invalid team directory entry.');
    }
    ids.add(team.teamId);
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) throw new Error('Team directory is too large.');
  return structuredClone(value) as AppTeam[];
}

/** A renderer-owned directory projection, never Team or native authorization authority. */
export function registerAppPluginExecutionTargets(window: BrowserWindow): {
  listTeams(): readonly AppTeam[];
  close(): void;
} {
  const contents = window.webContents;
  let teams: readonly AppTeam[] | null = null;
  let revision = 0;
  let accepting = true;
  let closed = false;
  const clear = () => { teams = null; revision = 0; };
  const navigate = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (!mainFrame || inPlace) return;
    accepting = false;
    clear();
  };
  const committed = () => { accepting = true; };
  ipcMain.handle(CHANNEL, (event, value: unknown) => {
    if (closed || !accepting || window.isDestroyed() || contents.isDestroyed()
      || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
      throw new Error('Team directory requires the trusted application main frame.');
    }
    try {
      const input = requireObject(value, ['revision', 'teams']);
      if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision <= 0) {
        throw new Error('Invalid team directory revision.');
      }
      if (input.revision <= revision) return;
      revision = input.revision;
      teams = readTeams(input.teams);
    } catch (error) {
      teams = null;
      throw error;
    }
  });
  contents.on('did-start-navigation', navigate);
  contents.on('did-navigate', committed);
  contents.on('render-process-gone', clear);
  contents.on('destroyed', clear);
  const close = () => {
    if (closed) return;
    closed = true;
    clear();
    ipcMain.removeHandler(CHANNEL);
    contents.removeListener('did-start-navigation', navigate);
    contents.removeListener('did-navigate', committed);
    contents.removeListener('render-process-gone', clear);
    contents.removeListener('destroyed', clear);
    window.removeListener('closed', close);
  };
  window.on('closed', close);
  return {
    listTeams() {
      if (closed || !accepting || window.isDestroyed() || contents.isDestroyed() || teams === null) {
        throw new AppPluginError('busy', 'Team directory is unavailable.');
      }
      return structuredClone(teams);
    },
    close,
  };
}
