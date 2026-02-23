import { ipcMain } from 'electron';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../utils/logger';
import { expandPath, getOpenClawConfigDir } from '../utils/paths';

type TeamFsWorkspaceMap = Record<string, string>;

interface TeamFsBaseInput {
  teamId: string;
  controllerId: string;
  workspaceByAgent: TeamFsWorkspaceMap;
}

interface TeamFsTaskInput extends TeamFsBaseInput {
  taskId: string;
  agentId: string;
}

interface TeamFsSyncMemberInput extends TeamFsBaseInput {
  memberId: string;
}

interface TeamFsPublishTaskInput extends TeamFsTaskInput {
  runId?: string;
  status: string;
  rawText?: string;
  error?: string;
  report?: Record<string, unknown>;
}

interface TeamFsDeleteLayoutResult {
  teamId: string;
  canonicalRoot: string;
  removedPaths: string[];
  missingPaths: string[];
}

interface TeamFsExportFlowInput extends TeamFsBaseInput {
  flowEvents: Array<Record<string, unknown>>;
  teamName?: string;
  phase?: string;
}

interface TeamIndexTaskRow {
  taskId: string;
  latestStatus: string;
  latestRunId?: string;
  latestReportPath?: string;
  latestAuditPath?: string;
  updatedAt: string;
}

interface TeamIndex {
  teamId: string;
  controllerId: string;
  canonicalRoot: string;
  updatedAt: string;
  tasks: Record<string, TeamIndexTaskRow>;
}

const SAFE_SEGMENT_REGEX = /^[a-zA-Z0-9._-]+$/;

function sanitizeSegment(value: string, fieldName: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || !SAFE_SEGMENT_REGEX.test(trimmed)) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }
  return trimmed;
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const relPath = relative(basePath, targetPath);
  return relPath === '' || (!relPath.startsWith('..') && !relPath.includes(':'));
}

function resolveWorkspaceRoot(rawPath: string, agentId: string): string {
  const input = String(rawPath ?? '').trim();
  if (!input) {
    throw new Error(`Missing workspace for agent: ${agentId}`);
  }
  const resolved = resolve(expandPath(input));
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Workspace not found for agent ${agentId}: ${resolved}`);
  }
  return resolved;
}

function resolveLayout(input: TeamFsBaseInput) {
  const teamId = sanitizeSegment(input.teamId, 'teamId');
  const controllerId = sanitizeSegment(input.controllerId, 'controllerId');
  const workspaceByAgent = input.workspaceByAgent ?? {};
  const mirrorRootByAgent: Record<string, string> = {};

  for (const [rawAgentId, rawWorkspace] of Object.entries(workspaceByAgent)) {
    const agentId = sanitizeSegment(rawAgentId, 'agentId');
    const workspaceRoot = resolveWorkspaceRoot(rawWorkspace, agentId);
    const mirrorRoot = join(workspaceRoot, '.clawx', 'teams', teamId);
    if (!isPathInside(workspaceRoot, mirrorRoot)) {
      throw new Error(`Unsafe mirror path for ${agentId}`);
    }
    mirrorRootByAgent[agentId] = mirrorRoot;
  }

  const controllerMirrorRoot = mirrorRootByAgent[controllerId];
  if (!controllerMirrorRoot) {
    throw new Error(`Controller workspace not found for ${controllerId}`);
  }
  const canonicalRoot = join(getOpenClawConfigDir(), 'team-runs', teamId);

  return {
    teamId,
    controllerId,
    canonicalRoot,
    controllerMirrorRoot,
    mirrorRootByAgent,
  };
}

function ensureDir(pathname: string): void {
  mkdirSync(pathname, { recursive: true });
}

function readJson<T>(pathname: string): T | null {
  try {
    if (!existsSync(pathname)) {
      return null;
    }
    return JSON.parse(readFileSync(pathname, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(pathname: string, payload: unknown): void {
  ensureDir(dirname(pathname));
  writeFileSync(pathname, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function copyDirIfExists(src: string, dst: string): void {
  if (!existsSync(src)) {
    return;
  }
  rmSync(dst, { recursive: true, force: true });
  ensureDir(dirname(dst));
  cpSync(src, dst, { recursive: true, force: true });
}

function copyFileIfExists(src: string, dst: string): void {
  if (!existsSync(src)) {
    return;
  }
  ensureDir(dirname(dst));
  cpSync(src, dst, { force: true });
}

function ensureIndex(layout: { teamId: string; controllerId: string; canonicalRoot: string }): string {
  const indexPath = join(layout.canonicalRoot, 'index.json');
  const current = readJson<TeamIndex>(indexPath);
  if (current) {
    return indexPath;
  }
  writeJson(indexPath, {
    teamId: layout.teamId,
    controllerId: layout.controllerId,
    canonicalRoot: layout.canonicalRoot,
    updatedAt: new Date().toISOString(),
    tasks: {},
  } satisfies TeamIndex);
  return indexPath;
}

function buildTaskPaths(input: TeamFsTaskInput) {
  const layout = resolveLayout(input);
  const taskId = sanitizeSegment(input.taskId, 'taskId');
  const agentId = sanitizeSegment(input.agentId, 'agentId');

  const canonicalTaskRoot = join(layout.canonicalRoot, 'tasks', taskId);
  const canonicalAgentDir = join(canonicalTaskRoot, 'agents', agentId);
  const canonicalSharedDir = join(canonicalTaskRoot, 'shared');
  const memberRoot = layout.mirrorRootByAgent[agentId];
  if (!memberRoot) {
    throw new Error(`Workspace not found for task agent: ${agentId}`);
  }
  const memberAgentDir = join(memberRoot, 'tasks', taskId, 'agents', agentId);
  const memberSharedDir = join(memberRoot, 'tasks', taskId, 'shared');

  return {
    ...layout,
    taskId,
    agentId,
    canonicalTaskRoot,
    canonicalAgentDir,
    canonicalSharedDir,
    memberAgentDir,
    memberSharedDir,
  };
}

function syncTaskProjectionToMembers(input: {
  taskId: string;
  controllerId: string;
  mirrorRootByAgent: Record<string, string>;
  canonicalTaskRoot: string;
  indexPath: string;
}) {
  const reportPath = join(input.canonicalTaskRoot, 'report.json');
  const sharedPath = join(input.canonicalTaskRoot, 'shared');

  for (const [agentId, memberRoot] of Object.entries(input.mirrorRootByAgent)) {
    if (agentId === input.controllerId) {
      continue;
    }
    const memberTaskRoot = join(memberRoot, 'tasks', input.taskId);
    ensureDir(memberTaskRoot);
    rmSync(join(memberTaskRoot, 'agents'), { recursive: true, force: true });
    copyDirIfExists(sharedPath, join(memberTaskRoot, 'shared'));
    copyFileIfExists(reportPath, join(memberTaskRoot, 'report.json'));
    copyFileIfExists(input.indexPath, join(memberRoot, 'index.json'));
  }
}

function syncCanonicalProjectionToController(input: {
  canonicalRoot: string;
  controllerMirrorRoot: string;
  canonicalTaskRoot?: string;
  auditPath?: string;
}): void {
  ensureDir(input.controllerMirrorRoot);
  if (input.canonicalTaskRoot) {
    const taskId = input.canonicalTaskRoot.split(/[\\/]/).pop();
    if (taskId) {
      copyDirIfExists(input.canonicalTaskRoot, join(input.controllerMirrorRoot, 'tasks', taskId));
    }
  } else {
    copyDirIfExists(join(input.canonicalRoot, 'tasks'), join(input.controllerMirrorRoot, 'tasks'));
    copyDirIfExists(join(input.canonicalRoot, 'audit'), join(input.controllerMirrorRoot, 'audit'));
  }
  copyFileIfExists(join(input.canonicalRoot, 'index.json'), join(input.controllerMirrorRoot, 'index.json'));
  if (input.auditPath) {
    const auditFileName = input.auditPath.split(/[\\/]/).pop();
    if (auditFileName) {
      copyFileIfExists(input.auditPath, join(input.controllerMirrorRoot, 'audit', auditFileName));
    }
  }
}

function appendAuditRecord(canonicalRoot: string, payload: Record<string, unknown>): string {
  const auditDir = join(canonicalRoot, 'audit');
  ensureDir(auditDir);
  const filename = `${Date.now()}-${crypto.randomUUID()}.json`;
  const auditPath = join(auditDir, filename);
  writeJson(auditPath, payload);
  return auditPath;
}

function resolveDeleteLayout(input: TeamFsBaseInput): {
  teamId: string;
  canonicalRoot: string;
  mirrorRoots: string[];
} {
  const teamId = sanitizeSegment(input.teamId, 'teamId');
  const workspaceByAgent = input.workspaceByAgent ?? {};
  const mirrorRoots = new Set<string>();

  for (const [rawAgentId, rawWorkspace] of Object.entries(workspaceByAgent)) {
    sanitizeSegment(rawAgentId, 'agentId');
    const workspaceValue = String(rawWorkspace ?? '').trim();
    if (!workspaceValue) {
      continue;
    }
    const workspaceRoot = resolve(expandPath(workspaceValue));
    const mirrorRoot = join(workspaceRoot, '.clawx', 'teams', teamId);
    if (!isPathInside(workspaceRoot, mirrorRoot)) {
      throw new Error(`Unsafe mirror path for ${rawAgentId}`);
    }
    mirrorRoots.add(mirrorRoot);
  }

  return {
    teamId,
    canonicalRoot: join(getOpenClawConfigDir(), 'team-runs', teamId),
    mirrorRoots: Array.from(mirrorRoots),
  };
}

export function registerTeamFsHandlers(): void {
  ipcMain.handle('teamfs:initLayout', async (_, input: TeamFsBaseInput) => {
    const layout = resolveLayout(input);
    ensureDir(layout.canonicalRoot);
    ensureDir(join(layout.canonicalRoot, 'tasks'));
    ensureDir(join(layout.canonicalRoot, 'audit'));
    ensureIndex(layout);

    for (const mirrorRoot of Object.values(layout.mirrorRootByAgent)) {
      ensureDir(mirrorRoot);
    }
    syncCanonicalProjectionToController({
      canonicalRoot: layout.canonicalRoot,
      controllerMirrorRoot: layout.controllerMirrorRoot,
    });

    return {
      teamId: layout.teamId,
      controllerId: layout.controllerId,
      canonicalRoot: layout.canonicalRoot,
      mirrorRootByAgent: layout.mirrorRootByAgent,
      indexPath: join(layout.canonicalRoot, 'index.json'),
    };
  });

  ipcMain.handle('teamfs:prepareTask', async (_, input: TeamFsTaskInput) => {
    const paths = buildTaskPaths(input);
    ensureDir(paths.canonicalTaskRoot);
    ensureDir(paths.canonicalAgentDir);
    ensureDir(paths.canonicalSharedDir);
    ensureDir(paths.memberAgentDir);
    ensureDir(paths.memberSharedDir);
    const indexPath = ensureIndex(paths);
    return {
      taskId: paths.taskId,
      agentId: paths.agentId,
      canonicalTaskRoot: paths.canonicalTaskRoot,
      canonicalAgentDir: paths.canonicalAgentDir,
      canonicalSharedDir: paths.canonicalSharedDir,
      memberAgentDir: paths.memberAgentDir,
      memberSharedDir: paths.memberSharedDir,
      indexPath,
    };
  });

  ipcMain.handle('teamfs:publishTask', async (_, input: TeamFsPublishTaskInput) => {
    const paths = buildTaskPaths(input);
    ensureDir(paths.canonicalTaskRoot);
    ensureDir(paths.canonicalSharedDir);
    ensureDir(paths.memberAgentDir);
    ensureDir(paths.memberSharedDir);

    copyDirIfExists(paths.memberAgentDir, paths.canonicalAgentDir);
    copyDirIfExists(paths.memberSharedDir, paths.canonicalSharedDir);
    if (input.rawText && input.rawText.trim()) {
      writeFileSync(join(paths.canonicalAgentDir, 'raw-output.md'), `${input.rawText.trim()}\n`, 'utf8');
    }
    if (input.error && input.error.trim()) {
      writeFileSync(join(paths.canonicalAgentDir, 'error.txt'), `${input.error.trim()}\n`, 'utf8');
    }

    const reportPath = join(paths.canonicalTaskRoot, 'report.json');
    if (input.report && Object.keys(input.report).length > 0) {
      writeJson(reportPath, input.report);
      const reportSummaryLines = [
        `status: ${String(input.status)}`,
        `agent: ${paths.agentId}`,
        `task: ${paths.taskId}`,
        `runId: ${input.runId ?? '-'}`,
      ];
      writeFileSync(
        join(paths.canonicalSharedDir, 'report-summary.md'),
        `${reportSummaryLines.join('\n')}\n`,
        'utf8',
      );
    }

    const indexPath = ensureIndex(paths);
    const index = readJson<TeamIndex>(indexPath) ?? {
      teamId: paths.teamId,
      controllerId: paths.controllerId,
      canonicalRoot: paths.canonicalRoot,
      updatedAt: new Date().toISOString(),
      tasks: {},
    };
    const nowIso = new Date().toISOString();
    const auditPath = appendAuditRecord(paths.canonicalRoot, {
      teamId: paths.teamId,
      taskId: paths.taskId,
      agentId: paths.agentId,
      runId: input.runId ?? null,
      status: input.status,
      error: input.error ?? null,
      reportPath: existsSync(reportPath) ? reportPath : null,
      timestamp: nowIso,
    });
    index.tasks[paths.taskId] = {
      taskId: paths.taskId,
      latestStatus: input.status,
      latestRunId: input.runId,
      latestReportPath: existsSync(reportPath) ? reportPath : undefined,
      latestAuditPath: auditPath,
      updatedAt: nowIso,
    };
    index.updatedAt = nowIso;
    writeJson(indexPath, index);

    syncTaskProjectionToMembers({
      taskId: paths.taskId,
      controllerId: paths.controllerId,
      mirrorRootByAgent: paths.mirrorRootByAgent,
      canonicalTaskRoot: paths.canonicalTaskRoot,
      indexPath,
    });
    syncCanonicalProjectionToController({
      canonicalRoot: paths.canonicalRoot,
      controllerMirrorRoot: paths.controllerMirrorRoot,
      canonicalTaskRoot: paths.canonicalTaskRoot,
      auditPath,
    });

    return {
      taskId: paths.taskId,
      agentId: paths.agentId,
      canonicalTaskRoot: paths.canonicalTaskRoot,
      canonicalAgentDir: paths.canonicalAgentDir,
      canonicalSharedDir: paths.canonicalSharedDir,
      reportPath: existsSync(reportPath) ? reportPath : null,
      indexPath,
      auditPath,
    };
  });

  ipcMain.handle('teamfs:publishShared', async (_, input: TeamFsTaskInput & {
    fileName: string;
    content: string;
  }) => {
    const paths = buildTaskPaths(input);
    const fileName = sanitizeSegment(input.fileName, 'fileName');
    ensureDir(paths.canonicalSharedDir);
    const sharedPath = join(paths.canonicalSharedDir, fileName);
    writeFileSync(sharedPath, input.content ?? '', 'utf8');
    const indexPath = ensureIndex(paths);

    syncTaskProjectionToMembers({
      taskId: paths.taskId,
      controllerId: paths.controllerId,
      mirrorRootByAgent: paths.mirrorRootByAgent,
      canonicalTaskRoot: paths.canonicalTaskRoot,
      indexPath,
    });
    syncCanonicalProjectionToController({
      canonicalRoot: paths.canonicalRoot,
      controllerMirrorRoot: paths.controllerMirrorRoot,
      canonicalTaskRoot: paths.canonicalTaskRoot,
    });

    return { sharedPath, indexPath };
  });

  ipcMain.handle('teamfs:syncMemberProjection', async (_, input: TeamFsSyncMemberInput) => {
    const layout = resolveLayout(input);
    const memberId = sanitizeSegment(input.memberId, 'memberId');
    const memberRoot = layout.mirrorRootByAgent[memberId];
    if (!memberRoot) {
      throw new Error(`Workspace not found for member: ${memberId}`);
    }

    if (memberId === layout.controllerId) {
      const canonicalTasksRoot = join(layout.canonicalRoot, 'tasks');
      ensureDir(canonicalTasksRoot);
      syncCanonicalProjectionToController({
        canonicalRoot: layout.canonicalRoot,
        controllerMirrorRoot: layout.controllerMirrorRoot,
      });
      return {
        teamId: layout.teamId,
        memberId,
        memberRoot,
        syncedTaskCount: readdirSync(canonicalTasksRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && SAFE_SEGMENT_REGEX.test(entry.name))
          .length,
      };
    }

    const canonicalTasksRoot = join(layout.canonicalRoot, 'tasks');
    ensureDir(canonicalTasksRoot);
    ensureDir(memberRoot);

    let syncedTaskCount = 0;
    const taskDirs = readdirSync(canonicalTasksRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SAFE_SEGMENT_REGEX.test(entry.name))
      .map((entry) => entry.name);

    for (const taskId of taskDirs) {
      const canonicalTaskRoot = join(canonicalTasksRoot, taskId);
      const memberTaskRoot = join(memberRoot, 'tasks', taskId);
      ensureDir(memberTaskRoot);
      rmSync(join(memberTaskRoot, 'agents'), { recursive: true, force: true });
      copyDirIfExists(join(canonicalTaskRoot, 'shared'), join(memberTaskRoot, 'shared'));
      copyFileIfExists(join(canonicalTaskRoot, 'report.json'), join(memberTaskRoot, 'report.json'));
      syncedTaskCount += 1;
    }

    copyFileIfExists(join(layout.canonicalRoot, 'index.json'), join(memberRoot, 'index.json'));

    return {
      teamId: layout.teamId,
      memberId,
      memberRoot,
      syncedTaskCount,
    };
  });

  ipcMain.handle('teamfs:deleteLayout', async (_, input: TeamFsBaseInput): Promise<TeamFsDeleteLayoutResult> => {
    const layout = resolveDeleteLayout(input);
    const removedPaths: string[] = [];
    const missingPaths: string[] = [];
    const targets = [layout.canonicalRoot, ...layout.mirrorRoots];

    for (const target of targets) {
      if (!existsSync(target)) {
        missingPaths.push(target);
        continue;
      }
      rmSync(target, { recursive: true, force: true });
      removedPaths.push(target);
    }

    return {
      teamId: layout.teamId,
      canonicalRoot: layout.canonicalRoot,
      removedPaths,
      missingPaths,
    };
  });

  ipcMain.handle('teamfs:exportFlowEvents', async (_, input: TeamFsExportFlowInput) => {
    const layout = resolveLayout(input);
    ensureDir(layout.canonicalRoot);
    ensureDir(join(layout.canonicalRoot, 'audit'));
    ensureIndex(layout);

    const fileName = `flow-events-${Date.now()}.json`;
    const auditPath = join(layout.canonicalRoot, 'audit', fileName);
    writeJson(auditPath, {
      teamId: layout.teamId,
      teamName: input.teamName ?? null,
      phase: input.phase ?? null,
      exportedAt: new Date().toISOString(),
      count: Array.isArray(input.flowEvents) ? input.flowEvents.length : 0,
      events: Array.isArray(input.flowEvents) ? input.flowEvents : [],
    });

    syncCanonicalProjectionToController({
      canonicalRoot: layout.canonicalRoot,
      controllerMirrorRoot: layout.controllerMirrorRoot,
      auditPath,
    });

    return {
      teamId: layout.teamId,
      canonicalRoot: layout.canonicalRoot,
      auditPath,
      fileName,
    };
  });

  logger.info('Team filesystem handlers registered');
}
