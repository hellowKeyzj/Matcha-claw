import { readFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getPluginPackageRoot(metaUrl: string): string {
  const moduleDir = dirname(fileURLToPath(metaUrl));
  if (basename(moduleDir) === "dist") {
    return dirname(moduleDir);
  }

  const parentDir = dirname(moduleDir);
  if (basename(parentDir) === "dist") {
    return dirname(parentDir);
  }

  return parentDir;
}

export function readPluginPackageVersion(metaUrl: string): string {
  try {
    const packageJsonPath = join(getPluginPackageRoot(metaUrl), "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}
