import os from "node:os";
import path from "node:path";
import { access, readFile, stat } from "node:fs/promises";
import { runAudit } from "./secureclaw-runtime/src/auditor.js";
import type { AuditContext, AuditReport, FileInfo, OpenClawConfig } from "./secureclaw-runtime/src/types.js";
import type { SecurityCoreRuntimeConfig } from "../core/types.js";

export function resolveStateDir(): string {
  const fromEnv = typeof process.env.OPENCLAW_STATE_DIR === "string" ? process.env.OPENCLAW_STATE_DIR.trim() : "";
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".openclaw");
}

async function createAuditContext(
  stateDir: string,
  runtimeConfig: SecurityCoreRuntimeConfig,
): Promise<AuditContext> {
  const configPath = path.join(stateDir, "openclaw.json");
  let loadedConfig: OpenClawConfig = {};
  try {
    const content = await readFile(configPath, "utf-8");
    loadedConfig = JSON.parse(content) as OpenClawConfig;
  } catch {
    loadedConfig = {};
  }

  loadedConfig.securityCore = {
    ...(loadedConfig.securityCore ?? {}),
    auditEgressAllowlist: [...runtimeConfig.auditEgressAllowlist],
    auditDailyCostLimitUsd: runtimeConfig.auditDailyCostLimitUsd,
    auditFailureMode: runtimeConfig.auditFailureMode,
  };

  return {
    stateDir,
    config: loadedConfig,
    platform: `${os.platform()}-${os.arch()}`,
    deploymentMode: "native",
    openclawVersion: "unknown",
    async fileInfo(filePath: string): Promise<FileInfo> {
      try {
        const fileStat = await stat(filePath);
        return {
          path: filePath,
          permissions: fileStat.mode & 0o777,
          exists: true,
          size: fileStat.size,
        };
      } catch {
        return { path: filePath, exists: false };
      }
    },
    async readFile(filePath: string): Promise<string | null> {
      try {
        return await readFile(filePath, "utf-8");
      } catch {
        return null;
      }
    },
    async listDir(dirPath: string): Promise<string[]> {
      try {
        const fs = await import("node:fs/promises");
        return await fs.readdir(dirPath);
      } catch {
        return [];
      }
    },
    async fileExists(filePath: string): Promise<boolean> {
      try {
        await access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    async getFilePermissions(filePath: string): Promise<number | null> {
      try {
        const fileStat = await stat(filePath);
        return fileStat.mode & 0o777;
      } catch {
        return null;
      }
    },
  };
}

export async function runSecureClawAudit(
  stateDir: string,
  runtimeConfig: SecurityCoreRuntimeConfig,
): Promise<AuditReport> {
  const context = await createAuditContext(stateDir, runtimeConfig);
  return runAudit({ context });
}
