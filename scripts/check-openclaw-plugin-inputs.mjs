#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();

const REQUIRED_LOCAL_PLUGINS = [
  {
    pluginId: 'task-manager',
    sourceDir: 'packages/openclaw-task-manager-plugin',
    expectedExtensions: ['./dist/index.js'],
    sourceEntries: ['./src/index.ts'],
  },
  {
    pluginId: 'security-core',
    sourceDir: 'packages/openclaw-security-plugin',
    expectedExtensions: ['./dist/index.js'],
    sourceEntries: ['./src/index.ts'],
  },
  {
    pluginId: 'browser-relay',
    sourceDir: 'packages/openclaw-browser-relay-plugin',
    expectedExtensions: ['./dist/index.js'],
    sourceEntries: ['./src/index.ts'],
  },
  {
    pluginId: 'memory-lancedb-pro',
    sourceDir: 'packages/memory-lancedb-pro',
    expectedExtensions: ['./dist/index.js'],
    sourceEntries: ['./index.ts', './cli.ts', './src/embedder.ts'],
  },
];

function fail(message, details = []) {
  console.error(message);
  for (const detail of details) console.error(`- ${detail}`);
  process.exit(1);
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function dependencyExists(packageName, nodeModulesDirs) {
  for (const nodeModulesDir of nodeModulesDirs) {
    const dependencyPath = path.join(nodeModulesDir, ...packageName.split('/'));
    if (await pathExists(dependencyPath)) {
      return true;
    }
  }
  return false;
}

async function validatePluginSource(plugin) {
  const sourceDir = path.join(ROOT, plugin.sourceDir);
  const manifestPath = path.join(sourceDir, 'openclaw.plugin.json');
  const packageJsonPath = path.join(sourceDir, 'package.json');
  const issues = [];

  if (!(await pathExists(sourceDir))) {
    issues.push(`缺少插件源码目录: ${plugin.sourceDir}`);
    return issues;
  }
  if (!(await pathExists(manifestPath))) {
    issues.push(`缺少 openclaw.plugin.json: ${plugin.sourceDir}`);
    return issues;
  }
  if (!(await pathExists(packageJsonPath))) {
    issues.push(`缺少 package.json: ${plugin.sourceDir}`);
    return issues;
  }

  let manifest;
  let packageJson;
  try {
    manifest = await readJson(manifestPath);
  } catch (error) {
    issues.push(`manifest JSON 不可解析: ${plugin.sourceDir} (${String(error)})`);
    return issues;
  }
  try {
    packageJson = await readJson(packageJsonPath);
  } catch (error) {
    issues.push(`package.json 不可解析: ${plugin.sourceDir} (${String(error)})`);
    return issues;
  }

  const manifestId = typeof manifest?.id === 'string' ? manifest.id.trim() : '';
  if (manifestId !== plugin.pluginId) {
    issues.push(`manifest.id 与预期不一致: ${plugin.sourceDir} (expected=${plugin.pluginId}, actual=${manifestId || 'EMPTY'})`);
  }

  const openclaw = isRecord(packageJson?.openclaw) ? packageJson.openclaw : null;
  const extensions = Array.isArray(openclaw?.extensions)
    ? openclaw.extensions.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  if (extensions.length === 0) {
    issues.push(`package.json 缺少 openclaw.extensions: ${plugin.sourceDir}`);
    return issues;
  }

  if (Array.isArray(plugin.expectedExtensions) && plugin.expectedExtensions.length > 0) {
    if (!sameStringArray(extensions, plugin.expectedExtensions)) {
      issues.push(
        `package.json openclaw.extensions 不符合预期: ${plugin.sourceDir} (expected=${plugin.expectedExtensions.join(', ')}, actual=${extensions.join(', ')})`,
      );
    }
  } else {
    for (const entry of extensions) {
      const entryPath = path.resolve(sourceDir, entry);
      if (!(await pathExists(entryPath))) {
        issues.push(`openclaw.extensions 指向不存在文件: ${plugin.sourceDir} -> ${entry}`);
      }
    }
  }

  const sourceEntries = Array.isArray(plugin.sourceEntries) ? plugin.sourceEntries : [];
  for (const sourceEntry of sourceEntries) {
    const sourceEntryPath = path.resolve(sourceDir, sourceEntry);
    if (!(await pathExists(sourceEntryPath))) {
      issues.push(`插件源码入口不存在: ${plugin.sourceDir} -> ${sourceEntry}`);
    }
  }

  const runtimeDependencyNames = Object.keys(
    isRecord(packageJson?.dependencies) ? packageJson.dependencies : {},
  );
  const nodeModulesDirs = [
    path.join(sourceDir, 'node_modules'),
    path.join(ROOT, 'node_modules'),
  ];
  for (const dependencyName of runtimeDependencyNames) {
    if (!(await dependencyExists(dependencyName, nodeModulesDirs))) {
      issues.push(`运行时依赖未安装，无法打包本地插件: ${plugin.sourceDir} -> ${dependencyName}`);
    }
  }

  return issues;
}

async function main() {
  const issues = [];
  for (const plugin of REQUIRED_LOCAL_PLUGINS) {
    const pluginIssues = await validatePluginSource(plugin);
    issues.push(...pluginIssues);
  }
  if (issues.length > 0) {
    fail('OpenClaw 插件源码输入校验失败（已阻止继续打包）', issues);
  }
  console.log(`OpenClaw 插件源码输入校验通过: ${REQUIRED_LOCAL_PLUGINS.map((item) => item.pluginId).join(', ')}`);
}

main().catch((error) => {
  fail('OpenClaw 插件源码输入校验异常退出', [String(error)]);
});
