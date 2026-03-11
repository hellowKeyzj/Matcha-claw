import { cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type MirrorMeta = {
  sourceRealDir: string;
  packageVersion: string;
  packageMtimeMs: number;
};

export interface EnsureBundledPluginsMirrorOptions {
  openclawDir: string;
  mirrorRootDir: string;
  packaged: boolean;
  logger?: LoggerLike;
}

const META_FILE = '.mirror-meta.json';

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readMirrorMeta(metaPath: string): Promise<MirrorMeta | null> {
  try {
    const raw = await readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<MirrorMeta>;
    if (
      typeof parsed.sourceRealDir !== 'string'
      || typeof parsed.packageVersion !== 'string'
      || typeof parsed.packageMtimeMs !== 'number'
    ) {
      return null;
    }
    return {
      sourceRealDir: parsed.sourceRealDir,
      packageVersion: parsed.packageVersion,
      packageMtimeMs: parsed.packageMtimeMs,
    };
  } catch {
    return null;
  }
}

async function resolveSourceMeta(openclawDir: string): Promise<MirrorMeta | null> {
  const sourceDir = path.join(openclawDir, 'extensions');
  if (!(await pathExists(sourceDir))) {
    return null;
  }

  const sourceRealDir = await realpath(sourceDir).catch(() => sourceDir);

  const packageJsonPath = path.join(openclawDir, 'package.json');
  let packageVersion = '';
  let packageMtimeMs = 0;
  try {
    const raw = await readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string') {
      packageVersion = parsed.version;
    }
    packageMtimeMs = (await stat(packageJsonPath)).mtimeMs;
  } catch (error) {
    void error;
  }

  return {
    sourceRealDir,
    packageVersion,
    packageMtimeMs,
  };
}

function isSameMirrorMeta(left: MirrorMeta | null, right: MirrorMeta): boolean {
  return !!left
    && left.sourceRealDir === right.sourceRealDir
    && left.packageVersion === right.packageVersion
    && left.packageMtimeMs === right.packageMtimeMs;
}

export async function ensureBundledPluginsMirrorDir(
  options: EnsureBundledPluginsMirrorOptions,
): Promise<string | undefined> {
  const sourceMeta = await resolveSourceMeta(options.openclawDir);
  if (!sourceMeta) {
    return undefined;
  }

  if (options.packaged) {
    return sourceMeta.sourceRealDir;
  }

  const mirrorDir = options.mirrorRootDir;
  const mirrorMetaPath = path.join(mirrorDir, META_FILE);
  const existingMeta = await readMirrorMeta(mirrorMetaPath);
  const hasMirror = await pathExists(mirrorDir);

  if (hasMirror && isSameMirrorMeta(existingMeta, sourceMeta)) {
    return mirrorDir;
  }

  const tmpDir = `${mirrorDir}.tmp-${Date.now()}`;
  await rm(tmpDir, { recursive: true, force: true });

  try {
    await mkdir(path.dirname(mirrorDir), { recursive: true });
    await cp(sourceMeta.sourceRealDir, tmpDir, {
      recursive: true,
      force: true,
      dereference: true,
    });
    await writeFile(path.join(tmpDir, META_FILE), JSON.stringify(sourceMeta, null, 2), 'utf8');

    await rm(mirrorDir, { recursive: true, force: true });
    await rename(tmpDir, mirrorDir);
    options.logger?.info?.(`已刷新 OpenClaw 插件镜像目录: ${mirrorDir}`);
    return mirrorDir;
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    options.logger?.warn?.(`刷新 OpenClaw 插件镜像目录失败: ${String(error)}`);
    return sourceMeta.sourceRealDir;
  }
}
