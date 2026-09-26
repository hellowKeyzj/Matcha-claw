#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  findOpenClawPluginSdkImportIssues,
  formatOpenClawPluginSdkImportIssue,
} from './lib/openclaw-plugin-sdk-import-policy.mjs';

const ROOT = process.cwd();
const MIRROR_ROOT = path.join(ROOT, 'build', 'openclaw-plugins');

const REQUIRED_PLUGIN_MIRRORS = [
  ...['qianfan', 'stepfun', 'tencent', 'xiaomi', 'qwen', 'kimi', 'volcengine', 'opencode'].map((pluginId) => ({
    pluginId,
    dir: pluginId,
    requiredFiles: pluginId === 'tencent' ? ['dist/index.js', 'dist/setup-api.js'] : ['dist/index.js'],
  })),
  {
    pluginId: 'task-manager',
    dir: 'task-manager',
    scanSdkImports: true,
  },
  {
    pluginId: 'security-core',
    dir: 'security-core',
    scanSdkImports: true,
  },
  {
    pluginId: 'browser-relay',
    dir: 'browser-relay',
    scanSdkImports: true,
  },
  {
    pluginId: 'memory-lancedb-pro',
    dir: 'memory-lancedb-pro',
    scanSdkImports: true,
    requiredFiles: [
      'models/Xenova/all-MiniLM-L6-v2/config.json',
      'models/Xenova/all-MiniLM-L6-v2/tokenizer.json',
      'models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json',
      'models/Xenova/all-MiniLM-L6-v2/onnx/model.onnx',
    ],
  },
  {
    pluginId: 'dingtalk',
    dir: 'dingtalk',
  },
  {
    pluginId: 'wecom-openclaw-plugin',
    dir: 'wecom',
  },
  {
    pluginId: 'openclaw-weixin',
    dir: 'openclaw-weixin',
  },
  {
    pluginId: 'qqbot',
    dir: 'qqbot',
  },
  {
    pluginId: 'openclaw-lark',
    dir: 'openclaw-lark',
    scanSdkImports: true,
    requiredFiles: [
      'dist/index.mjs',
      'dist/secret-contract-api.mjs',
      'dist/config-schema.mjs',
      'secret-contract-api.js',
      'skills',
      'LICENSE',
    ],
  },
  {
    pluginId: 'matchaclaw-media',
    dir: 'matchaclaw-media',
    scanSdkImports: true,
  },
];

function fail(message, details = []) {
  console.error(message);
  for (const detail of details) {
    console.error(`- ${detail}`);
  }
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

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function validateMirror(definition) {
  const mirrorDir = path.join(MIRROR_ROOT, definition.dir);
  const manifestPath = path.join(mirrorDir, 'openclaw.plugin.json');
  const packageJsonPath = path.join(mirrorDir, 'package.json');
  const issues = [];

  if (!(await pathExists(mirrorDir))) {
    issues.push(`缺少 build 插件镜像目录: build/openclaw-plugins/${definition.dir}`);
    return issues;
  }
  if (!(await pathExists(manifestPath))) {
    issues.push(`缺少 build 镜像 manifest: build/openclaw-plugins/${definition.dir}/openclaw.plugin.json`);
    return issues;
  }
  if (!(await pathExists(packageJsonPath))) {
    issues.push(`缺少 build 镜像 package.json: build/openclaw-plugins/${definition.dir}/package.json`);
    return issues;
  }

  let manifest;
  let packageJson;
  try {
    manifest = await readJson(manifestPath);
  } catch (error) {
    issues.push(`build manifest JSON 不可解析: ${definition.dir} (${String(error)})`);
    return issues;
  }
  try {
    packageJson = await readJson(packageJsonPath);
  } catch (error) {
    issues.push(`build package.json 不可解析: ${definition.dir} (${String(error)})`);
    return issues;
  }

  const manifestId = typeof manifest?.id === 'string' ? manifest.id.trim() : '';
  if (manifestId !== definition.pluginId) {
    issues.push(`build manifest.id 不匹配: ${definition.dir} (expected=${definition.pluginId}, actual=${manifestId || 'EMPTY'})`);
  }

  const openclaw = isRecord(packageJson?.openclaw) ? packageJson.openclaw : null;
  const sourceExtensions = Array.isArray(openclaw?.extensions)
    ? openclaw.extensions.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];
  const runtimeExtensions = Array.isArray(openclaw?.runtimeExtensions)
    ? openclaw.runtimeExtensions.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];
  const extensions = runtimeExtensions.length > 0 ? runtimeExtensions : sourceExtensions;
  if (extensions.length === 0) {
    issues.push(`build package.json 缺少 openclaw.extensions/openclaw.runtimeExtensions: ${definition.dir}`);
    return issues;
  }

  const sdkImportScanFiles = [];
  for (const entry of extensions) {
    const entryPath = path.resolve(mirrorDir, entry);
    if (!(await pathExists(entryPath))) {
      issues.push(`build openclaw.extensions 入口不存在: ${definition.dir} -> ${entry}`);
      continue;
    }
    sdkImportScanFiles.push(entryPath);
  }

  if (definition.scanSdkImports) {
    const sdkImportIssues = await findOpenClawPluginSdkImportIssues({ files: sdkImportScanFiles });
    issues.push(...sdkImportIssues.map((issue) => formatOpenClawPluginSdkImportIssue(issue, ROOT)));
  }

  const runtimeDependencyNames = Object.keys(
    isRecord(packageJson?.dependencies) ? packageJson.dependencies : {},
  );
  for (const dependencyName of runtimeDependencyNames) {
    const dependencyPackageJsonPath = path.join(mirrorDir, 'node_modules', ...dependencyName.split('/'), 'package.json');
    if (!(await pathExists(dependencyPackageJsonPath))) {
      issues.push(`build 运行时依赖缺失: ${definition.dir} -> node_modules/${dependencyName}`);
    }
  }

  const requiredFiles = Array.isArray(definition.requiredFiles) ? definition.requiredFiles : [];
  for (const relativeFile of requiredFiles) {
    const targetPath = path.join(mirrorDir, relativeFile);
    if (!(await pathExists(targetPath))) {
      issues.push(`build 插件资源缺失: ${definition.dir} -> ${relativeFile}`);
    }
  }

  return issues;
}

async function main() {
  const issues = [];
  for (const plugin of REQUIRED_PLUGIN_MIRRORS) {
    const pluginIssues = await validateMirror(plugin);
    issues.push(...pluginIssues);
  }

  if (issues.length > 0) {
    fail('OpenClaw build 插件镜像校验失败（已阻止继续打包）', issues);
  }

  console.log(
    `OpenClaw build 插件镜像校验通过: ${REQUIRED_PLUGIN_MIRRORS.map((item) => item.pluginId).join(', ')}`,
  );
}

main().catch((error) => {
  fail('OpenClaw build 插件镜像校验异常退出', [String(error)]);
});
