import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';
import { assertOfficeNative, officeNativeDirectory, officeOcrHelperName, officeSidecarName } from './native.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(root, 'apps/office/genoffice');
const engine = join(source, 'apps/sheets/native/xlsx-engine');
const helpers = join(source, 'packages/pdf2docx/ocr-helper');
const outputRoot = dirname(officeNativeDirectory('linux', 'x64'));
const cargoDirectory = join(outputRoot, '.cargo-target');
const targets = {
  win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
  linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' }
};

export function parseArgs(args = process.argv.slice(2)) {
  const { values } = parseNodeArgs({
    args,
    options: { platform: { type: 'string' }, arch: { type: 'string', multiple: true } },
    strict: true,
    allowPositionals: false
  });
  const options = { platform: values.platform, arches: [...new Set(values.arch ?? [])] };
  buildPlan(options);
  return options;
}

// Importing and planning never probes toolchains, creates directories, or starts a build.
export function buildPlan({ platform, arches }) {
  if (!Object.hasOwn(targets, platform) || !Array.isArray(arches) || !arches.length
    || arches.some((arch) => !Object.hasOwn(targets[platform], arch))) {
    throw new Error('Usage: node apps/office/build-native.mjs --platform win32|darwin|linux --arch x64|arm64 [--arch x64|arm64]');
  }
  return [...new Set(arches)].map((arch) => {
    const target = targets[platform][arch];
    const sidecar = officeSidecarName(platform);
    const ocr = officeOcrHelperName(platform);
    const env = platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: '11.0' } : {};
    if (platform === 'linux' && arch !== process.arch) {
      const key = `CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`;
      // Rust's target stdlib alone is insufficient: a target linker and sysroot must be installed.
      env[key] = process.env[key] || `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux-gnu-gcc`;
    }
    return {
      platform,
      arch,
      target,
      outputDirectory: officeNativeDirectory(platform, arch),
      sidecar,
      sidecarSource: join(cargoDirectory, target, 'release', sidecar),
      cargo: {
        command: 'cargo',
        args: ['build', '--locked', '--release', '--target', target,
          '--manifest-path', join(engine, 'Cargo.toml'), '--config', join(engine, '.cargo/config.toml'),
          '--target-dir', cargoDirectory, '--bin', 'xlsx-sidecar'],
        env
      },
      ocr: !ocr ? undefined : {
        name: ocr,
        source: join(helpers, platform === 'win32' ? 'win-ocr.cs' : 'vision-ocr.swift'),
        command: platform === 'win32' ? 'csc.exe' : 'xcrun',
        args: platform === 'win32'
          ? ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu']
          : ['--sdk', 'macosx', 'swiftc', '-O', '-target', `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx11.0`]
      }
    };
  });
}

function newestWith(directory, file, pattern) {
  if (!existsSync(directory)) return undefined;
  const versions = readdirSync(directory)
    .filter((name) => pattern.test(name) && existsSync(join(directory, name, file)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.length ? join(directory, versions[versions.length - 1], file) : undefined;
}

function windowsOcrCommand(ocr, output) {
  const windir = process.env.WINDIR ?? 'C:\\Windows';
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const command = join(windir, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!existsSync(command)) throw new Error(`Missing inbox .NET Framework compiler: ${command}`);
  const kits = join(programFiles, 'Windows Kits/10/UnionMetadata');
  // Facade/Windows.winmd is only type-forwarding metadata; use the versioned union alone.
  const winmd = newestWith(kits, 'Windows.winmd', /^\d/) ?? join(kits, 'Windows.winmd');
  if (!existsSync(winmd)) throw new Error(`Missing Windows 10/11 SDK Windows.winmd under ${kits}`);
  const gac = join(windir, 'Microsoft.NET/assembly/GAC_MSIL');
  const netfx = join(programFiles, 'Reference Assemblies/Microsoft/Framework/.NETFramework');
  const winrt = newestWith(join(gac, 'System.Runtime.WindowsRuntime'), 'System.Runtime.WindowsRuntime.dll', /^v\d/)
    ?? join(netfx, 'v4.8/Facades/System.Runtime.WindowsRuntime.dll');
  if (!existsSync(winrt)) throw new Error('Missing System.Runtime.WindowsRuntime.dll (GAC or .NET Framework v4.8 facades)');
  const facades = ['System.Runtime', 'System.Runtime.InteropServices.WindowsRuntime'].map((name) => (
    newestWith(netfx, `Facades/${name}.dll`, /^v4/)
      ?? newestWith(join(gac, name), `${name}.dll`, /^v\d/)
  )).filter(Boolean);
  return {
    command,
    args: [...ocr.args, ...[winmd, winrt, ...facades].map((file) => `/r:${file}`), `/out:${output}`, ocr.source]
  };
}

function run({ command, args, env }) {
  console.log(command, ...args);
  // Inherit vcvarsall's target-specific MSVC environment, including x64 -> ARM64 builds.
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
}

async function buildNative(plans) {
  const platform = plans[0].platform;
  if (platform !== process.platform) {
    throw new Error(`Office ${platform} producers must run on ${platform}, not ${process.platform}. Cross-architecture builds require the target Rust stdlib and linker/SDK.`);
  }
  await mkdir(outputRoot, { recursive: true });
  const work = await mkdtemp(join(outputRoot, `.${platform}-`));
  try {
    // Invalidate only requested targets; publish none until every requested target validates.
    for (const plan of plans) await rm(plan.outputDirectory, { recursive: true, force: true });
    let windowsOcr;
    if (platform === 'win32') {
      windowsOcr = join(work, plans[0].ocr.name);
      run(windowsOcrCommand(plans[0].ocr, windowsOcr));
      const bytes = await readFile(windowsOcr);
      for (const arch of ['x64', 'arm64']) assertOfficeNative(bytes, platform, arch, plans[0].ocr.name);
      console.log('win-ocr.exe: verified AnyCPU pure IL for x64 and arm64, not native x86.');
    }
    for (const plan of plans) {
      const staging = join(work, `${platform}-${plan.arch}`);
      await mkdir(staging);
      run(plan.cargo);
      await copyFile(plan.sidecarSource, join(staging, plan.sidecar));
      if (windowsOcr) {
        await copyFile(windowsOcr, join(staging, plan.ocr.name));
      } else if (plan.ocr) {
        run({ ...plan.ocr, args: [...plan.ocr.args, plan.ocr.source, '-o', join(staging, plan.ocr.name)], env: plan.cargo.env });
      }
      for (const name of [plan.sidecar, plan.ocr?.name].filter(Boolean)) {
        const file = join(staging, name);
        assertOfficeNative(await readFile(file), platform, plan.arch, name);
        if (platform !== 'win32') await chmod(file, 0o755);
      }
    }
    for (const plan of plans) {
      await rename(join(work, `${platform}-${plan.arch}`), plan.outputDirectory);
      console.log(`Built Office native producers: ${plan.outputDirectory}`);
    }
  } catch (error) {
    for (const plan of plans) await rm(plan.outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildNative(buildPlan(parseArgs()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
