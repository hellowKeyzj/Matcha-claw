import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHtml } from '../../sdk/app-plugins/tooling/build.mjs';
import { assertDesignNative } from './native.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const id = 'matcha.design';
const arm64Runtime = ['msvcp140.dll', 'vcruntime140.dll'];

async function signDesignNative(directory, packager) {
  if (!packager) return;
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const { findIdentity, isSignAllowed } = builderRequire('app-builder-lib/out/codeSign/macCodeSign');
  const options = packager.platformSpecificBuildOptions;
  if (!isSignAllowed() || options.identity === null || options.identity === '-' || options.type === 'development') {
    if (packager.forceCodeSigning) throw new Error('Bundled Design release binaries require Developer ID signing.');
    return;
  }
  const { keychainFile } = await packager.codeSigningInfo.value;
  const identity = await findIdentity('Developer ID Application', options.identity, keychainFile);
  if (!identity?.name.startsWith('Developer ID Application:')) {
    if (packager.forceCodeSigning) throw new Error('No Developer ID Application identity for bundled Design binaries.');
    return;
  }
  // App signing cannot reach Mach-O members inside the plugin ZIP.
  for (const binary of ['vendor/skia.node', 'bin/ffmpeg']) {
    const file = join(directory, binary);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', identity.hash || identity.name,
      '--timestamp', '--options', 'runtime', ...(keychainFile ? ['--keychain', keychainFile] : []), file],
    { stdio: 'inherit', timeout: 120_000 });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', '--test-requirement',
      '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', file],
    { stdio: 'inherit', timeout: 120_000 });
  }
}

export function validatePlugin(contents, platform, arch) {
  if (contents.manifest.id !== id) throw new Error(`Bundled Design package must declare ${id}.`);
  const build = contents.files.get('BUILD.txt');
  if (!build || !Buffer.from(build).toString('utf8').split('\n').includes(`Target: ${platform}-${arch}`)) {
    throw new Error(`Bundled Design build receipt does not match ${platform}-${arch}.`);
  }
  assertDesignNative(contents.files.get('vendor/skia.node'), platform, arch, 'skia.node');
  const executable = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  assertDesignNative(contents.files.get(`bin/${executable}`), platform, arch, executable);
  const notices = ['THIRD-PARTY-NOTICES.txt', 'bin/FFMPEG-LICENSE.txt', 'bin/FFMPEG-README.txt'];
  if (platform === 'win32' && arch === 'arm64') {
    for (const name of arm64Runtime) assertDesignNative(contents.files.get(`vendor/${name}`), platform, arch, name);
    notices.push('vendor/VCRUNTIME-LICENSE.rtf', 'vendor/VCRUNTIME-README.txt');
  }
  for (const file of notices) {
    if (!contents.files.get(file)?.length) throw new Error(`Bundled Design package is missing ${file}.`);
  }
}

export async function buildPlugin({ platform = process.platform, arch = process.arch, outputDirectory = join(root, 'dist'), packager } = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported Design target: ${platform}-${arch}.`);
  }
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('Design package.json and manifest.json versions must match.');
  const skiaEntry = require.resolve('skia-canvas');
  const nativeDirectory = join(root, '../../build/design-native', `${platform}-${arch}`);
  const executable = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  let skiaNative;
  let ffmpeg;
  const nativeDirectoryStat = await stat(nativeDirectory).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (nativeDirectoryStat) {
    if (!nativeDirectoryStat.isDirectory()) throw new Error(`Design native dependency input must be a directory: ${nativeDirectory}.`);
    skiaNative = join(nativeDirectory, 'skia.node');
    ffmpeg = join(nativeDirectory, executable);
  } else if (platform === process.platform && arch === process.arch) {
    skiaNative = join(dirname(skiaEntry), 'skia.node');
    ffmpeg = require('ffmpeg-static');
  } else {
    throw new Error(`Missing Design native dependencies for ${platform}-${arch}: ${nativeDirectory}.${platform === 'win32' && arch === 'arm64' ? ' Run node apps/design/prepare-win-arm64.mjs first.' : ''} Cross-target packaging never uses host dependencies.`);
  }
  if (!ffmpeg) throw new Error(`FFmpeg is not available for ${platform}-${arch}; ffmpeg-static 5.3.0 does not support Windows arm64. Supply target dependencies in ${nativeDirectory}.`);
  for (const path of [skiaNative, ffmpeg, `${ffmpeg}.LICENSE`, `${ffmpeg}.README`]) {
    if (!(await stat(path).catch(() => null))?.isFile()) {
      throw new Error(`Missing build dependency: ${path}. Supply this target's native dependencies before building; installed plugins never download them.`);
    }
  }
  assertDesignNative(await readFile(skiaNative), platform, arch, 'skia.node');
  assertDesignNative(await readFile(ffmpeg), platform, arch, executable);
  const runtimeFiles = platform === 'win32' && arch === 'arm64'
    ? [...arm64Runtime.map((name) => [name, name]), ['vcrt.LICENSE.rtf', 'VCRUNTIME-LICENSE.rtf'], ['vcrt.README', 'VCRUNTIME-README.txt']]
    : [];
  for (const [source] of runtimeFiles) {
    const path = join(nativeDirectory, source);
    if (!(await stat(path).catch(() => null))?.isFile()) throw new Error(`Missing Design ARM64 runtime dependency: ${path}. Run node apps/design/prepare-win-arm64.mjs first.`);
    if (source.endsWith('.dll')) assertDesignNative(await readFile(path), platform, arch, source);
  }

  await mkdir(dirname(outputDirectory), { recursive: true });
  const output = await mkdtemp(join(dirname(outputDirectory), '.build-design-'));
  try {
    await mkdir(join(output, 'vendor'));
    await mkdir(join(output, 'bin'));
    await Promise.all([
      build({
        entryPoints: [join(root, 'src/activate.ts')], outfile: join(output, 'main.cjs'),
        bundle: true, platform: 'node', format: 'cjs', target: 'node22',
        alias: { '@matcha/app-plugins-sdk': join(root, '../../sdk/app-plugins/dist/index.js') },
        plugins: [{
          name: 'bundled-skia',
          setup(builder) {
            builder.onResolve({ filter: /^skia-canvas$/ }, () => ({ path: './vendor/skia.cjs', external: true }));
          },
        }],
      }),
      build({
        entryPoints: [skiaEntry], outfile: join(output, 'vendor/skia.cjs'),
        bundle: true, platform: 'node', format: 'cjs', target: 'node22', keepNames: true, external: ['sharp'],
        plugins: [{
          name: 'native-skia',
          setup(builder) {
            builder.onResolve({ filter: /\.node$/ }, () => ({ path: './skia.node', external: true }));
          },
        }],
      }),
      copyFile(skiaNative, join(output, 'vendor/skia.node')),
      copyFile(ffmpeg, join(output, 'bin', executable)),
      copyFile(`${ffmpeg}.LICENSE`, join(output, 'bin/FFMPEG-LICENSE.txt')),
      copyFile(`${ffmpeg}.README`, join(output, 'bin/FFMPEG-README.txt')),
      ...runtimeFiles.map(([source, destination]) => copyFile(join(nativeDirectory, source), join(output, 'vendor', destination))),
    ]);
    const html = await buildHtml({ root, source: 'index.html' });
    await writeFile(join(output, 'editor.html'), html);
    await copyFile(join(root, 'manifest.json'), join(output, 'manifest.json'));
    await writeFile(join(output, 'BUILD.txt'), `Matcha Design ${version}\nTarget: ${platform}-${arch}\nKonva 10.3.0 + Skia Canvas 3.0.4\nFFmpeg: see bin/FFMPEG-README.txt and bin/FFMPEG-LICENSE.txt\n`);
    const notices = [];
    for (const name of ['react', 'react-dom', 'konva', 'skia-canvas', 'lucide-react', '@modelcontextprotocol/ext-apps', 'fflate', 'i18next', 'react-i18next']) {
      let directory = dirname(require.resolve(name));
      while (!(await stat(join(directory, 'package.json')).catch(() => null))) directory = dirname(directory);
      notices.push(`${name}\n${await readFile(join(directory, 'LICENSE'), 'utf8')}`);
    }
    await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n'));
    if (platform === 'darwin') await signDesignNative(output, packager);
    // Replace the destination only after every component has built successfully.
    await rm(outputDirectory, { recursive: true, force: true });
    await rename(output, outputDirectory);
    console.log(`Built ${outputDirectory} for ${platform}-${arch}.`);
    return outputDirectory;
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPlugin();
