import { build } from 'esbuild';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHtml } from '../../sdk/app-plugins/tooling/build.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const skiaEntry = require.resolve('skia-canvas');
const skiaNative = join(dirname(skiaEntry), 'skia.node');
const ffmpeg = require('ffmpeg-static');
if (!ffmpeg) throw new Error(`FFmpeg is not available for ${process.platform}-${process.arch}.`);
for (const path of [skiaNative, ffmpeg, `${ffmpeg}.LICENSE`, `${ffmpeg}.README`]) {
  if (!(await stat(path).catch(() => null))?.isFile()) {
    throw new Error(`Missing build dependency: ${path}. Install this platform's native dependencies before building; installed plugins never download them.`);
  }
}

const output = await mkdtemp(join(root, '.build-'));
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
    copyFile(ffmpeg, join(output, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')),
    copyFile(`${ffmpeg}.LICENSE`, join(output, 'bin/FFMPEG-LICENSE.txt')),
    copyFile(`${ffmpeg}.README`, join(output, 'bin/FFMPEG-README.txt')),
  ]);
  const html = await buildHtml({ root, source: 'index.html' });
  await writeFile(join(output, 'editor.html'), html);
  await copyFile(join(root, 'manifest.json'), join(output, 'manifest.json'));
  await writeFile(join(output, 'BUILD.txt'), `Matcha Design ${version}\nTarget: ${process.platform}-${process.arch}\nKonva 10.3.0 + Skia Canvas 3.0.4\nFFmpeg: see bin/FFMPEG-README.txt and bin/FFMPEG-LICENSE.txt\n`);
  const notices = [];
  for (const name of ['react', 'react-dom', 'konva', 'skia-canvas', 'lucide-react', '@modelcontextprotocol/ext-apps', 'fflate', 'i18next', 'react-i18next']) {
    let directory = dirname(require.resolve(name));
    while (!(await stat(join(directory, 'package.json')).catch(() => null))) directory = dirname(directory);
    notices.push(`${name}\n${await readFile(join(directory, 'LICENSE'), 'utf8')}`);
  }
  await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n'));
  // dist is this script's output only; replace it after every component has built successfully.
  await rm(join(root, 'dist'), { recursive: true, force: true });
  await rename(output, join(root, 'dist'));
  console.log(`Built apps/design/dist for ${process.platform}-${process.arch}.`);
} finally {
  await rm(output, { recursive: true, force: true });
}
