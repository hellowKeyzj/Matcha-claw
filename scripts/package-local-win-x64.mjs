#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { createRuntimeHostNativeBuildPlan } from './build-runtime-host-native.mjs';
import { isNativeExecutable } from '../electron/main/runtime-host-delivery/native-artifact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'release', 'local-win-x64');
const work = path.join(root, 'build', 'local-win-x64');
const guard = path.join(root, 'scripts', 'lib', 'windows-bounded-run.py');
const node = process.execPath;
const require = createRequire(import.meta.url);
let stage = '环境检查';

function execute(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`${command}: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

async function fileHash(file, algorithm, encoding) {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest(encoding);
}

function msvcEnvironment() {
  const installer = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer');
  const installation = execute(path.join(installer, 'vswhere.exe'), [
    '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath',
  ]);
  if (!installation) throw new Error('未安装 Visual Studio C++ x64 Build Tools');
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = `${installer};${env[pathKey] || ''}`;
  const vcvars = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
  const initialized = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', `"${vcvars}"`, 'x64', '>nul', '&&', 'set'], {
    cwd: root, env, windowsVerbatimArguments: true, encoding: 'utf8', windowsHide: true,
  });
  if (initialized.error || initialized.status !== 0) {
    throw new Error(`MSVC 初始化失败: ${initialized.error?.message || initialized.stderr}`);
  }
  for (const line of initialized.stdout.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      const name = line.slice(0, separator);
      const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) || name;
      env[key] = line.slice(separator + 1);
    }
  }
  for (const key of Object.keys(env)) {
    if (/^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_PROFILE_RELEASE_.*|SKIP_MATCHA_AGENT_BUILD|SKIP_PREINSTALLED_SKILLS|ELECTRON_RUN_AS_NODE|BOUNDED_MSVC_TELEMETRY_EXE)$/i.test(key)) {
      delete env[key];
    }
  }
  env.CARGO_BUILD_JOBS = '1';
  env.BOUNDED_DISK_RESERVE_GIB = '1';
  env.PROTOC = path.join(root, 'resources', 'bin', 'protoc', 'win32-x64', 'bin', 'protoc.exe');
  env.PROTOC_INCLUDE = path.join(root, 'resources', 'bin', 'protoc', 'win32-x64', 'include');
  return env;
}

async function run(label, command, args, env, capGiB = 4, timeout = 900) {
  stage = label;
  console.log(`\n[本地打包] ${label}`);
  const log = createWriteStream(path.join(work, `${label}.log`), { flags: 'w' });
  const child = spawn('python', ['-I', guard, root, String(capGiB), String(timeout), command, ...args], {
    cwd: root, env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
  child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`exit ${code}, signal ${signal || 'none'}`)));
    });
  } finally {
    await new Promise(resolve => log.end(resolve));
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此入口只用于 Windows x64');
  if (process.argv.length > 2) throw new Error('此入口不接受额外参数');
  const pnpm = process.env.npm_execpath;
  if (!pnpm || !existsSync(pnpm)) throw new Error('请使用 pnpm run package:win:x64:local 启动');
  execute('python', ['-I', '-c', 'import struct; assert struct.calcsize("P") == 8']);
  const env = msvcEnvironment();
  mkdirSync(work, { recursive: true });
  console.log('[本地打包] Windows x64；Host ThinLTO/codegen1（不同于 CI 完整 LTO）；串行编译；不会安装或发布');
  const nodeStep = (label, args, cap, timeout) => run(label, node, args, env, cap, timeout);
  await nodeStep('01-插件输入', ['scripts/check-openclaw-plugin-inputs.mjs']);
  await nodeStep('02-依赖缓存', [pnpm, 'run', 'prep:win-x64-binaries:local-functional-cache']);
  await nodeStep('03-protoc', ['scripts/download-bundled-protoc.mjs']);
  await nodeStep('04-Wiki资产', ['scripts/download-wiki-assets.mjs', '--check', '--platform', 'win32', '--arch', 'x64']);
  await nodeStep('05-ripgrep', ['scripts/download-matcha-ripgrep.mjs', '--arch', 'x64']);
  await nodeStep('06-预装技能', ['scripts/bundle-preinstalled-skills.mjs', '--reuse-cache']);
  const compiler = execute('where.exe', ['cl.exe'], env).split(/\r?\n/)[0];
  const telemetry = path.join(path.dirname(compiler), 'vctip.exe');
  const cargoEnv = { ...env };
  if (existsSync(telemetry)) cargoEnv.BOUNDED_MSVC_TELEMETRY_EXE = telemetry;
  const network = path.join(work, 'network');
  await run('06-网络', node, ['scripts/build-network-access.mjs', '--platform', 'win32', '--arch', 'x64', '--artifact-dir', network], cargoEnv, 4, 7200);

  const plan = createRuntimeHostNativeBuildPlan({ rootDir: root, platform: 'win32', arch: 'x64' });
  await run('07-AppServer', 'cargo', plan.appServer.cargoArgs, cargoEnv, 9, 7200);
  await run('08-Host', 'cargo', ['rustc', ...plan.cargoArgs.slice(1), '--', '-C', 'lto=thin', '-C', 'codegen-units=1'], cargoEnv, 9, 7200);
  const native = path.join(work, 'native');
  mkdirSync(native, { recursive: true });
  for (const [name, source] of [
    ['runtime-host.exe', plan.sourceBinaryPath],
    ['matcha-app-server.exe', plan.appServer.sourceBinaryPath],
  ]) {
    if (!isNativeExecutable(source, 'win32', 'x64')) throw new Error(`无效的原生编译产物: ${source}`);
    copyFileSync(source, path.join(native, name));
  }

  await nodeStep('09-桌面', [pnpm, 'run', 'build:vite'], 7, 1200);
  await nodeStep('10-AgentCLI', ['scripts/build-matcha-agent.mjs', '--arch', 'x64', '--if-needed'], 7, 1200);
  await nodeStep('11-OpenClaw', ['scripts/bundle-openclaw.mjs'], 4, 1200);
  await nodeStep('12-插件', ['scripts/bundle-openclaw-plugins.mjs'], 4, 1200);
  await nodeStep('13-插件镜像', ['scripts/check-openclaw-plugin-mirrors.mjs']);
  await run('14-Python312', path.join(root, 'resources/bin/win32-x64/uv.exe'), ['python', 'install', '3.12'], env);
  await nodeStep('15-SearXNG', ['scripts/bundle-searxng.mjs', '--target', 'win32-x64'], 4, 1800);

  const config = parse(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  for (const resource of config.win.extraResources) {
    if (resource.from.startsWith('runtime-host/dist/')) {
      resource.from = native;
      resource.filter = ['runtime-host.exe'];
    } else if (resource.from.startsWith('matcha-agent/app-server/dist/')) {
      resource.from = native;
      resource.filter = ['matcha-app-server.exe'];
    } else if (resource.to === 'bin/easytier') {
      resource.from = network;
    }
  }
  config.directories.output = output;
  config.electronDist = path.join(root, 'node_modules/electron/dist');
  const configPath = path.join(work, 'electron-builder.yml');
  writeFileSync(configPath, stringify(config));
  const metadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  rmSync(path.join(output, `${metadata.name}-${metadata.version}-x64.nsis.7z`), { force: true });
  await run('16-NSIS', node, [require.resolve('electron-builder/out/cli/cli.js'), '--config', configPath, '--win', 'nsis', '--x64', '--publish', 'never'], { ...env, ELECTRON_BUILDER_COMPRESSION_LEVEL: '5' }, 10, 1800);

  await run('17-原生依赖', path.join(output, 'win-unpacked', 'MatchaClaw.exe'), ['-e', `
    const { createRequire } = require('node:module');
    const { dirname, join } = require('node:path');
    const packaged = createRequire(${JSON.stringify(path.join(output, 'win-unpacked/resources/app.asar/package.json'))});
    for (const name of ['@lydell/node-pty', 'koffi']) {
      packaged(name);
      console.log(name + ' loaded from packaged app');
    }
    const native = join(dirname(packaged.resolve('@lydell/node-pty-win32-x64')), 'utils.js');
    packaged(native).loadNativeModule('conpty');
    console.log('ConPTY native addon loaded from packaged app');
  `], { ...env, ELECTRON_RUN_AS_NODE: '1' }, 1, 60);
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  await run('18-安装包完整性', appBuilderRequire('7zip-bin').path7za, ['t', path.join(output, `MatchaClaw-${metadata.version}-win-x64.exe`)], env, 2, 600);
  stage = '产物校验';
  const installer = path.join(output, `MatchaClaw-${metadata.version}-win-x64.exe`);
  const sha512 = await fileHash(installer, 'sha512', 'base64');
  const update = parse(readFileSync(path.join(output, 'latest.yml'), 'utf8'));
  if (update.sha512 !== sha512) throw new Error('安装包与更新清单摘要不一致');
  for (const name of ['runtime-host.exe', 'matcha-app-server.exe']) {
    if (await fileHash(path.join(native, name), 'sha256', 'hex')
      !== await fileHash(path.join(output, 'win-unpacked/resources/bin/win32-x64', name), 'sha256', 'hex')) {
      throw new Error(`安装包 staging 未使用本次编译产物: ${name}`);
    }
  }
  for (const name of ['matcha-network.exe', 'Packet.dll', 'LICENSE', 'manifest.json']) {
    if (await fileHash(path.join(network, name), 'sha256', 'hex')
      !== await fileHash(path.join(output, 'win-unpacked/resources/bin/easytier', name), 'sha256', 'hex')) {
      throw new Error(`安装包 staging 未使用本次网络产物: ${name}`);
    }
  }
  console.log(`\n[本地打包] 成功: ${installer}`);
  console.log(`[本地打包] SHA256: ${await fileHash(installer, 'sha256', 'hex')}`);
}

main().catch(error => {
  console.error(`\n[本地打包] 失败阶段: ${stage}\n${error.message}\n日志目录: ${work}`);
  process.exitCode = 1;
});
