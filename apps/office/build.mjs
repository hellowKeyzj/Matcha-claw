import { build, transform } from 'esbuild';
import Ajv from 'ajv';
import { gzipSync } from 'node:zlib';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { preparePatches } from './scripts/patches.mjs';
import { MAX_APP_PLUGIN_CONTENT_BYTES, MAX_APP_PLUGIN_FILES } from '../../sdk/app-plugins/dist/package.js';

const root = dirname(fileURLToPath(import.meta.url));
const id = 'matcha.office';
const genoffice = join(root, 'genoffice');
const requireFromHere = createRequire(import.meta.url);

const EDITORS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'];

const packageRoots = {
  'cli': join(genoffice, 'packages', 'cli'),
  'compound-file': join(genoffice, 'packages', 'compound-file'),
  'doc2docx': join(genoffice, 'packages', 'doc2docx'),
  'hwp2docx': join(genoffice, 'packages', 'hwp2docx'),
  'html2docx': join(genoffice, 'packages', 'html2docx'),
  'odf2ooxml': join(genoffice, 'packages', 'odf2ooxml'),
  'pdf2docx': join(genoffice, 'packages', 'pdf2docx'),
  'ppt2pptx': join(genoffice, 'packages', 'ppt2pptx'),
  'agent-core': join(genoffice, 'packages', 'agent-core'),
  'ai-provider': join(genoffice, 'packages', 'ai-provider'),
  'ai-search': join(genoffice, 'packages', 'ai-search'),
  'docx-engine': join(genoffice, 'packages', 'docx-engine'),
  'electron-utils': join(genoffice, 'packages', 'electron-utils'),
  'file-parse': join(genoffice, 'packages', 'file-parse'),
  'font-metrics': join(genoffice, 'packages', 'font-metrics'),
  i18n: join(genoffice, 'packages', 'i18n'),
  pipelines: join(genoffice, 'packages', 'pipelines'),
  'pptx-engine': join(genoffice, 'packages', 'pptx-engine'),
  'pptx-ops': join(genoffice, 'packages', 'pptx-ops'),
  'pptx-render': join(genoffice, 'packages', 'pptx-render'),
  'project-store': join(genoffice, 'packages', 'project-store'),
  ui: join(genoffice, 'packages', 'ui'),
  'xlsx-gateway': join(genoffice, 'packages', 'xlsx-gateway'),
  'zip-gate': join(genoffice, 'packages', 'zip-gate')
};

function resolveOfficePackage(path) {
  return requireFromHere.resolve(path === 'katex' || path.startsWith('katex/')
    ? path.replace(/^katex/, 'genoffice-katex') : path);
}

function officeDependencies() {
  return {
    name: 'office-dependency-versions',
    setup(builder) {
      builder.onResolve({ filter: /^katex(?:\/|$)/ }, (args) => (
        args.path.includes('?') ? undefined : { path: resolveOfficePackage(args.path) }
      ));
    }
  };
}

function genofficeResolver() {
  return {
    name: 'genoffice-source-resolver',
    setup(builder) {
      builder.onResolve({ filter: /^@genoffice\// }, (args) => {
        const wantsUrl = args.path.endsWith('?url');
        const rest = args.path.slice('@genoffice/'.length, wantsUrl ? -4 : undefined);
        const [packageName, ...subpath] = rest.split('/');
        const packageRoot = packageRoots[packageName];
        if (!packageRoot) return;
        const path = subpath.join('/');
        if (wantsUrl) {
          return { path: join(packageRoot, 'src', path), namespace: 'url-asset' };
        }
        if (packageName === 'font-metrics' && path === 'word-faces.json') {
          return { path: join(packageRoot, 'word-faces.json') };
        }
        if (args.kind === 'url-token') {
          return { path: join(packageRoot, 'src', path) };
        }
        const candidates = path
          ? [join(packageRoot, 'src', path), join(packageRoot, 'src', `${path}.ts`), join(packageRoot, 'src', `${path}.tsx`), join(packageRoot, 'src', path, 'index.ts'), join(packageRoot, 'src', path, 'index.tsx')]
          : [join(packageRoot, 'src', 'index.ts'), join(packageRoot, 'src', 'index.tsx')];
        return { path: candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? candidates[0] };
      });
    }
  };
}

function urlAssets(loader = 'file') {
  return {
    name: 'url-assets',
    setup(builder) {
      builder.onResolve({ filter: /\?url$/ }, (args) => (
        args.path.startsWith('@genoffice/')
          ? undefined
          : args.path.startsWith('.')
            ? { path: resolve(args.resolveDir, args.path.replace(/\?url$/, '')), namespace: 'url-asset' }
            : { path: requireFromHere.resolve(args.path.slice(0, -4)), namespace: 'url-asset' }
      ));
      builder.onLoad({ filter: /.*/, namespace: 'url-asset' }, async (args) => ({
        contents: await readFile(args.path),
        loader
      }));
    }
  };
}

function sharedUiAssets() {
  return {
    name: 'genoffice-ui-assets',
    setup(builder) {
      builder.onResolve({ filter: /^@genoffice\/ui\/fonts\/Carlito-(?:Regular|Bold|Italic|BoldItalic)\.ttf(?:\?url)?$/ }, (args) => {
        const file = basename(args.path.replace(/\?url$/, ''));
        return args.kind === 'url-token'
          ? { path: `../native/fonts/${file}`, external: true }
          : { path: file, namespace: 'shared-native-font' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'shared-native-font' }, (args) => ({
        contents: `export default new URL(${JSON.stringify('native/fonts/' + args.path)}, document.baseURI).href;`,
        loader: 'js'
      }));
      builder.onResolve({ filter: /^@genoffice\/ui\/fonts\// }, (args) => {
        if (args.path.includes('?')) return;
        return {
          path: join(genoffice, 'packages', 'ui', 'src', 'fonts', args.path.slice('@genoffice/ui/fonts/'.length))
        };
      });
    }
  };
}

const parserBundles = new WeakMap();

function mermaidParser(patches) {
  return {
    name: 'office-mermaid-parser',
    setup(builder) {
      builder.onLoad({ filter: /[\\/]@mermaid-js[\\/]parser[\\/]dist[\\/]mermaid-parser\.core\.mjs$/ }, async (args) => {
        let bundled = parserBundles.get(patches);
        if (!bundled) {
          bundled = build({
            entryPoints: [args.path],
            bundle: true,
            write: false,
            platform: 'neutral',
            format: 'esm',
            target: 'es2022',
            minify: true,
            charset: 'utf8'
          }).then((result) => result.outputFiles[0].text);
          parserBundles.set(patches, bundled);
        }
        return { contents: await bundled, loader: 'js', resolveDir: dirname(args.path) };
      });
    }
  };
}

function runtimeAssets(assets) {
  return {
    name: 'genoffice-runtime-assets',
    setup(builder) {
      builder.onResolve({ filter: /\?asset$/ }, (args) => {
        const requested = args.path.slice(0, -'?asset'.length);
        let path;
        if (/node_modules[\\/]harfbuzzjs[\\/]dist[\\/]harfbuzz\.wasm$/.test(requested)) {
          path = requireFromHere.resolve('harfbuzzjs/dist/harfbuzz.wasm');
        } else if (requested.startsWith('@genoffice/')) {
          const [packageName, ...parts] = requested.slice('@genoffice/'.length).split('/');
          const packageRoot = packageRoots[packageName];
          if (!packageRoot) return;
          path = join(packageRoot, 'src', ...parts);
        } else if (requested.startsWith('.')) {
          path = resolve(args.resolveDir, requested);
        } else {
          return;
        }
        const name = basename(path);
        const group = name === 'harfbuzz.wasm' ? 'harfbuzz' : 'fonts';
        const target = join(group, name);
        assets.set(target, path);
        return { path, namespace: 'runtime-asset', pluginData: { target } };
      });
      builder.onLoad({ filter: /.*/, namespace: 'runtime-asset' }, (args) => {
        const target = args.pluginData?.target;
        if (typeof target !== 'string') throw new Error('Runtime asset target is missing.');
        return {
          contents: `import { join } from 'node:path';\nexport default join(__dirname, 'native', ${JSON.stringify(target)});`,
          loader: 'js'
        };
      });
      builder.onResolve({ filter: /harfbuzzjs[\\/]dist[\\/]harfbuzz\.js$/ }, () => ({
        path: 'harfbuzz-runtime',
        namespace: 'harfbuzz-runtime'
      }));
      builder.onLoad({ filter: /.*/, namespace: 'harfbuzz-runtime' }, () => ({
        contents: `import { join } from 'node:path';\nimport { pathToFileURL } from 'node:url';\nexport default async function createHarfBuzz(options) {\n  const module = await import(pathToFileURL(join(__dirname, 'native', 'harfbuzz', 'harfbuzz.mjs')).href);\n  return module.default(options);\n}`,
        loader: 'js'
      }));
    }
  };
}

function rawText(patches) {
  return {
    name: 'raw-text',
    setup(builder) {
      builder.onResolve({ filter: /\?inline$/ }, (args) => ({
        path: args.path.startsWith('.') ? resolve(args.resolveDir, args.path.slice(0, -7)) : resolveOfficePackage(args.path.slice(0, -7)),
        namespace: 'inline-css'
      }));
      builder.onLoad({ filter: /.*/, namespace: 'inline-css' }, async (args) => {
        let css = await readFile(args.path, 'utf8');
        for (const match of [...css.matchAll(/url\(([^)]+)\)/g)]) {
          const relative = match[1].replace(/^['"]|['"]$/g, '');
          if (/^(?:data:|https?:|#)/.test(relative)) continue;
          const source = relative.startsWith('@genoffice/')
            ? (() => { const [name, ...parts] = relative.slice('@genoffice/'.length).split('/'); return join(packageRoots[name], 'src', ...parts); })()
            : resolve(dirname(args.path), relative);
          const font = await readFile(source);
          const mime = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' }[extname(relative)] ?? 'application/octet-stream';
          css = css.replace(match[0], `url(data:${mime};base64,${font.toString('base64')})`);
        }
        return { contents: css, loader: 'text' };
      });
      builder.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
        namespace: 'raw-text'
      }));
      builder.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
        contents: patches.readFile(args.path) ?? await readFile(args.path, 'utf8'),
        loader: 'text'
      }));
      builder.onResolve({ filter: /(^|\/)dom$/ }, (args) => (
        /cli[\\/]src[\\/](formats|commands)[\\/]/.test(args.importer)
          ? { path: join(root, 'src', 'platform', 'replacements', 'dom.ts') }
          : undefined
      ));
    }
  };
}

function editorReplacements() {
  return {
    name: 'office-editor-replacements',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/preview\/PreviewFrame$/ }, (args) => (
        args.importer === join(genoffice, 'apps', 'html', 'src', 'renderer', 'App.tsx')
          ? { path: join(root, 'src', 'html', 'PreviewFrame.tsx') }
          : undefined
      ));
      builder.onResolve({ filter: /^node:/ }, (args) => (
        args.importer === join(genoffice, 'apps', 'slides', 'src', 'main', 'pdf-export.ts')
          ? { path: args.path, external: true }
          : undefined
      ));
    }
  };
}

function sheetsPdfPreload(patches) {
  const source = join(genoffice, 'apps', 'sheets', 'src', 'preload', 'index.ts');
  return {
    name: 'sheets-pdf-preload',
    setup(builder) {
      builder.onResolve({ filter: /preload\/index$/ }, (args) => (
        args.importer === join(root, 'src', 'sheets', 'pdf-worker.tsx')
          ? { path: source, namespace: 'sheets-pdf-preload' } : undefined
      ));
      builder.onResolve({ filter: /^@genoffice\/electron-utils\/drop-open$/, namespace: 'sheets-pdf-preload' }, () => ({ path: join(genoffice, 'packages', 'electron-utils', 'src', 'drop-open.ts'), namespace: 'sheets-pdf-preload' }));
      builder.onResolve({ filter: /^electron$/, namespace: 'sheets-pdf-preload' }, () => ({ path: join(root, 'src', 'sheets', 'pdf-preload.ts') }));
      builder.onLoad({ filter: /.*/, namespace: 'sheets-pdf-preload' }, async (args) => ({ contents: patches.readFile(args.path) ?? await readFile(args.path, 'utf8'), loader: 'ts', resolveDir: dirname(args.path) }));
    }
  };
}

export async function buildApplicationHtml(output, patches) {
  const rendererBuild = await build({
    metafile: true,
    entryPoints: Object.fromEntries(EDITORS.map((app) => [app, join(root, 'src', app, 'page.tsx')]).concat([
      ['browser-storage', join(root, 'src', 'platform', 'browser-storage.ts')],
      ['export-worker', join(root, 'src', 'slides', 'export-worker.ts')],
      ['docs-headless-worker', join(root, 'src', 'docs', 'headless-worker.tsx')],
      ['markdown-headless-worker', join(root, 'src', 'markdown', 'headless-worker.ts')],
      ['sheets-pdf-worker', join(root, 'src', 'sheets', 'pdf-worker.tsx')]
    ])),
    outdir: join(output, 'renderer'),
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    splitting: true,
    charset: 'utf8',
    alias: {
      '@matcha/sheets-app': join(genoffice, 'apps', 'sheets', 'src', 'renderer', 'App.tsx'),
      '@matcha/sheets-fonts': join(genoffice, 'apps', 'sheets', 'src', 'renderer', 'cell-font-fallback.ts'),
      '@matcha/sheets-locale': join(genoffice, 'apps', 'sheets', 'src', 'renderer', 'i18n', 'locale.tsx'),
      '@matcha/slides-app': join(genoffice, 'apps', 'slides', 'src', 'renderer', 'App.tsx'),
      '@matcha/slides-preload': join(genoffice, 'apps', 'slides', 'src', 'preload', 'index.ts'),
      '@matcha/slides-audience': join(genoffice, 'apps', 'slides', 'src', 'renderer', 'components', 'AudienceView.tsx'),
      '@matcha/slides-pdf-export': join(genoffice, 'apps', 'slides', 'src', 'main', 'pdf-export.ts'),
      '@matcha/html-app': join(genoffice, 'apps', 'html', 'src', 'renderer', 'App.tsx'),
      '@matcha/pdf-app': join(genoffice, 'apps', 'pdf', 'src', 'renderer', 'App.tsx'),
      '@matcha/pdf-actions': join(root, 'src', 'ui', 'document-actions.ts'),
      '@matcha/pdf-locale': join(genoffice, 'apps', 'pdf', 'src', 'renderer', 'i18n', 'locale.tsx')
    },
    target: 'chrome140',
    jsx: 'automatic',
    minify: true,
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      'import.meta.env.SSR': 'false',
      'process.env.NODE_ENV': '"production"',
      'process.env.H2D_DEBUG_KPI': 'undefined'
    },
    banner: {
      js: 'var process = globalThis.process || { env: { NODE_ENV: "production" }, platform: "browser", cwd: function () { return "/"; } };'
    },
    loader: {
      '.md': 'text',
      '.png': 'file', '.jpg': 'file', '.jpeg': 'file', '.gif': 'file',
      '.webp': 'file', '.svg': 'file', '.ico': 'file',
      '.ttf': 'file', '.otf': 'file', '.woff': 'file', '.woff2': 'file', '.wasm': 'file'
    },
    plugins: [sheetsPdfPreload(patches), {
      name: 'office-browser-electron',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: join(root, 'src', 'platform', 'electron-preload.ts') }));
      }
    }, patches.plugin, mermaidParser(patches), editorReplacements(), sharedUiAssets(), officeDependencies(), genofficeResolver(), urlAssets(), rawText(patches)]
  });
  const conversionBuild = await build({
    entryPoints: [join(root, 'src', 'conversion', 'worker.ts')],
    outfile: join(output, 'renderer', 'conversion-worker.js'),
    bundle: true,
    splitting: false,
    platform: 'browser',
    format: 'esm',
    target: 'chrome140',
    minify: true,
    charset: 'utf8',
    metafile: true,
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.H2D_DEBUG_KPI': 'undefined' },
    plugins: [patches.plugin, officeDependencies(), genofficeResolver(), rawText(patches)]
  });
  Object.assign(rendererBuild.metafile.inputs, conversionBuild.metafile.inputs);
  Object.assign(rendererBuild.metafile.outputs, conversionBuild.metafile.outputs);
  await buildDocsParseWorker(output, patches);
  if (process.env.OFFICE_ARTIFACT_REPORT) await writeFile(`${process.env.OFFICE_ARTIFACT_REPORT}.renderer.json`, JSON.stringify(rendererBuild.metafile, null, 2) + '\n');
  for (const app of EDITORS) {
    const css = existsSync(join(output, 'renderer', app + '.css'))
      ? '<link rel="stylesheet" href="renderer/' + app + '.css">' : '';
    await writeFile(join(output, app + '.html'), `<!doctype html>
<html lang="zh-CN" data-office-app="${app}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Matcha Office ${app}</title>${css}</head><body><div id="root"></div><script type="module">await import('./renderer/browser-storage.js'); await import('./renderer/${app}.js');</script></body></html>`);
  }
  const pdfjs = dirname(requireFromHere.resolve('pdfjs-dist/package.json'));
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    await cp(join(pdfjs, directory), join(output, 'pdfjs', directory), { recursive: true });
  }
}

export async function buildDocsParseWorker(output, patches) {
  const result = await build({
    entryPoints: [join(genoffice, 'apps', 'docs', 'src', 'renderer', 'parse-worker.ts')],
    outfile: join(output, 'renderer', 'docs-parse-worker.classic.js'),
    write: false,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    minify: true,
    charset: 'utf8',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [patches.plugin, genofficeResolver()]
  });
  await mkdir(join(output, 'renderer'), { recursive: true });
  await writeFile(join(output, 'renderer', 'docs-parse-worker.classic.js.gz'), gzipSync(result.outputFiles[0].contents, { level: 9 }));
}

function sidecarName(platform) {
  return platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar';
}

// Bundle both jsdom entry points, retaining the stylesheet and real sync-XHR worker.
export async function copyJsdomTree(destination, patches) {
  const source = dirname(requireFromHere.resolve('jsdom/package.json'));
  const target = join(destination, 'jsdom');
  const result = await build({
    entryPoints: {
      'api-bundle': 'jsdom-api-entry',
      'xhr-sync-worker-bundle': 'jsdom-worker-entry'
    },
    outdir: join(target, 'lib'),
    outExtension: { '.js': '.mjs' },
    chunkNames: '[name]-[hash]',
    bundle: true,
    platform: 'node',
    format: 'esm',
    splitting: true,
    charset: 'utf8',
    write: false,
    target: 'node24',
    minify: true,
    metafile: true,
    plugins: [patches.plugin, {
      name: 'jsdom-disk-resources',
      setup(builder) {
        // Keep entry-point strict mode inside its module; CSSOM contains sloppy-mode code.
        builder.onResolve({ filter: /^jsdom-(api|worker)-entry$/ }, (args) => ({ path: args.path, namespace: 'jsdom-entry' }));
        builder.onLoad({ filter: /.*/, namespace: 'jsdom-entry' }, (args) => ({
          contents: args.path === 'jsdom-api-entry'
            ? `const api = require(${JSON.stringify(join(source, 'lib', 'api.js'))});\n${['JSDOM', 'VirtualConsole', 'CookieJar', 'requestInterceptor', 'toughCookie'].map((name) => `export const ${name} = api.${name};`).join('\n')}`
            : `require(${JSON.stringify(join(source, 'lib', 'jsdom', 'living', 'xhr', 'xhr-sync-worker.js'))});`,
          loader: 'js',
          resolveDir: source
        }));
        builder.onResolve({ filter: /^\.\/xhr-sync-worker\.js$/ }, (args) => (
          args.kind === 'require-resolve' ? { path: './xhr-sync-worker.js', external: true } : undefined
        ));
      }
    }]
  });
  // Lower the shared graph to CommonJS: CSSOM relies on sloppy-mode assignments.
  await mkdir(join(target, 'lib'), { recursive: true });
  for (const file of result.outputFiles) {
    const contents = file.text.replace(/(["'])(\.\/[^"']+)\.mjs\1/g, '$1$2.cjs$1');
    const lowered = await transform(contents, { format: 'cjs', platform: 'node', target: 'node24', minify: true, charset: 'utf8', legalComments: 'inline' });
    await writeFile(file.path.replace(/\.mjs$/, '.cjs'), lowered.code);
  }
  await writeFile(join(target, 'lib', 'api.js'), 'const api = require("./api-bundle.cjs");\nexports.JSDOM = api.JSDOM;\nexports.VirtualConsole = api.VirtualConsole;\nexports.CookieJar = api.CookieJar;\nexports.requestInterceptor = api.requestInterceptor;\nexports.toughCookie = api.toughCookie;\n');
  await writeFile(join(target, 'lib', 'xhr-sync-worker.js'), 'require("./xhr-sync-worker-bundle.cjs");\n');
  await copyFile(join(source, 'package.json'), join(target, 'package.json'));
  await copyFile(join(source, 'LICENSE.txt'), join(target, 'LICENSE.txt'));
  await copyFile(join(source, 'lib', 'jsdom', 'browser', 'default-stylesheet.css'), join(target, 'lib', 'default-stylesheet.css'));
  const packages = new Set([source]);
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input.startsWith('jsdom-entry:')) continue;
    let directory = dirname(resolve(input));
    while (!existsSync(join(directory, 'package.json')) || !JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name) {
      directory = dirname(directory);
    }
    packages.add(directory);
  }
  const licenses = [];
  for (const directory of packages) {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    licenses.push(`${manifest.name}@${manifest.version}\nLicense: ${manifest.license}\n${JSON.stringify(manifest.author ?? manifest.contributors ?? '')}`);
    for (const name of await readdir(directory)) {
      if (!/^(license|licence|copying|notice)([._-]|$)/i.test(name)) continue;
      licenses.push(`${name}\n${await readFile(join(directory, name), 'utf8')}`);
    }
  }
  await writeFile(join(target, 'THIRD_PARTY_LICENSES.txt'), licenses.join('\n\n'));
}

export async function copySharpRuntime(destination, platform, arch, patches) {
  const copied = new Set();
  async function copyPackage(manifestPath) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (copied.has(manifest.name)) return;
    copied.add(manifest.name);
    const directory = dirname(manifestPath);
    const target = join(destination, manifest.name.replace(/^@img\//, ''));
    if (manifest.name === 'sharp') {
      await mkdir(join(target, 'lib'), { recursive: true });
      await build({
        entryPoints: [join(directory, manifest.main)],
        outfile: join(target, 'lib', 'index.js'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        minify: true,
        external: ['sharp-win32-*', 'sharp-darwin-*', 'sharp-linux-*', 'sharp-linuxmusl-*', 'sharp-libvips-*', '@img/sharp-*'],
        plugins: [patches.plugin]
      });
      await copyFile(manifestPath, join(target, 'package.json'));
      await copyFile(join(directory, 'LICENSE'), join(target, 'LICENSE'));
    } else {
      await cp(directory, target, {
        recursive: true,
        dereference: true,
        filter: (path) => !path.slice(directory.length).split(/[\\/]/).includes('node_modules')
      });
    }
    const require = createRequire(manifestPath);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      if (!dependency.startsWith(`@img/sharp-${platform}-${arch}`)
        && !dependency.startsWith(`@img/sharp-libvips-${platform}-${arch}`)) continue;
      await copyPackage(require.resolve(`${dependency}/package`));
    }
  }
  await copyPackage(requireFromHere.resolve('sharp/package.json'));
}

function sidecarPath(platform) {
  if (process.env.XLSX_SIDECAR_BIN) return process.env.XLSX_SIDECAR_BIN;
  return join(genoffice, 'apps', 'sheets', 'native', 'xlsx-engine', 'target', 'release', sidecarName(platform));
}

function assertNative(bytes, platform, name) {
  if (!bytes || bytes.length < 64) throw new Error(`Bundled ${name} is missing or empty.`);
  if (platform === 'win32') {
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error(`Bundled ${name} is not a Windows PE executable.`);
    return;
  }
  if (platform === 'linux') {
    if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) throw new Error(`Bundled ${name} is not an ELF executable.`);
    return;
  }
  const magic = bytes.readUInt32BE?.(0) ?? (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]);
  if (![0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcffaedfe, 0xcefaedfe].includes(magic >>> 0)) {
    throw new Error(`Bundled ${name} is not a Mach-O executable.`);
  }
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code) || attempt >= 5) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * 2 ** attempt));
    }
  }
}

async function assertArtifactBounds(directory) {
  const files = [];
  const groups = {};
  const hashes = new Map();
  async function visit(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(child, name + '/');
      else {
        const contents = await readFile(child);
        const file = { path: name, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
        files.push(file);
        const group = name.startsWith('node_modules/') ? name.split('/').slice(0, name.startsWith('node_modules/@') ? 3 : 2).join('/') : name.split('/')[0];
        groups[group] ??= { files: 0, bytes: 0 };
        groups[group].files++;
        groups[group].bytes += file.bytes;
        if (!hashes.has(file.sha256)) hashes.set(file.sha256, []);
        hashes.get(file.sha256).push(file);
      }
    }
  }
  await visit(directory);
  const count = files.length;
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const report = process.env.OFFICE_ARTIFACT_REPORT;
  if (report) {
    await mkdir(dirname(resolve(report)), { recursive: true });
    await writeFile(report, JSON.stringify({ files: count, bytes, limits: { files: MAX_APP_PLUGIN_FILES, bytes: MAX_APP_PLUGIN_CONTENT_BYTES }, groups, largest: [...files].sort((a, b) => b.bytes - a.bytes), duplicates: [...hashes.values()].filter((entries) => entries.length > 1).map((entries) => ({ sha256: entries[0].sha256, bytes: entries[0].bytes, wastedBytes: entries[0].bytes * (entries.length - 1), paths: entries.map((entry) => entry.path) })) }, null, 2) + '\n');
  }
  if (count > MAX_APP_PLUGIN_FILES || bytes > MAX_APP_PLUGIN_CONTENT_BYTES) {
    throw new Error(`Office artifact exceeds package limits: ${count}/${MAX_APP_PLUGIN_FILES} files, ${bytes}/${MAX_APP_PLUGIN_CONTENT_BYTES} bytes.`);
  }
}

export function validatePlugin(contents, platform, arch) {
  if (contents.manifest.id !== id) throw new Error(`Bundled Matcha Office package must declare ${id}.`);
  const required = [
    'main.cjs',
    'backend.mjs',
    'node_modules/jsdom/package.json',
    'node_modules/jsdom/lib/api.js',
    'node_modules/jsdom/lib/xhr-sync-worker.js',
    'node_modules/jsdom/lib/api-bundle.cjs',
    'node_modules/jsdom/lib/xhr-sync-worker-bundle.cjs',
    ...EDITORS.map((app) => `renderer/${app}.js`),
    'renderer/docs-parse-worker.classic.js.gz',
    'renderer/conversion-worker.js',
    'renderer/export-worker.js',
    'renderer/export-worker.css',
    'renderer/docs-headless-worker.js',
    'renderer/docs-headless-worker.css',
    'renderer/markdown-headless-worker.js',
    'renderer/markdown-headless-worker.css',
    'renderer/sheets-pdf-worker.js',
    'renderer/sheets-pdf-worker.css',
    'native/pdfium.wasm',
    'native/hb-subset.wasm',
    'native/rhwp_bg.wasm',
    ...(platform === 'win32' ? ['native/ocr/win-ocr.exe'] : platform === 'darwin' ? ['native/ocr/vision-ocr'] : []),
    'node_modules/jsdom/lib/default-stylesheet.css',
    'node_modules/jsdom/LICENSE.txt',
    'node_modules/jsdom/THIRD_PARTY_LICENSES.txt',
    'docs.html',
    'sheets.html',
    'slides.html',
    'pdf.html',
    'markdown.html',
    'html.html',
    'manifest.json',
    `native/${sidecarName(platform)}`,
    'LICENSE',
    'NOTICE'
  ];
  for (const name of required) {
    const bytes = contents.files.get(name);
    if (!bytes?.length) throw new Error(`Bundled Matcha Office package is missing ${name}.`);
  }
  assertNative(contents.files.get(`native/${sidecarName(platform)}`), platform, sidecarName(platform));
  if (!contents.files.get('BUILD.txt')?.length) throw new Error('Bundled Matcha Office package is missing BUILD.txt.');
  const buildReceipt = Buffer.from(contents.files.get('BUILD.txt')).toString('utf8');
  if (!buildReceipt.includes(`Target: ${platform}-${arch}`)) throw new Error(`Bundled Matcha Office build receipt does not match ${platform}-${arch}.`);
}

export async function buildBackend(output, patches, runtimeAssetFiles = new Map()) {
return build({
    entryPoints: [join(root, 'src', 'activate.ts')],
    metafile: true,
    outdir: output,
    entryNames: 'backend',
    chunkNames: '[name]-[hash]',
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    splitting: true,
    charset: 'utf8',
    target: 'node22',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: {
      js: 'import { createRequire as __officeCreateRequire } from "node:module"; import { fileURLToPath as __officeFileURLToPath } from "node:url"; import { dirname as __officeDirname } from "node:path"; const require = __officeCreateRequire(import.meta.url); const __filename = __officeFileURLToPath(import.meta.url); const __dirname = __officeDirname(__filename);'
    },
    alias: {
      '@matcha/app-plugins-sdk': join(root, '..', '..', 'sdk', 'app-plugins', 'src', 'index.ts'),
      '@matcha/slides-pdf-export': join(genoffice, 'apps', 'slides', 'src', 'main', 'pdf-export.ts'),
      '@matcha/sheets-main': join(genoffice, 'apps', 'sheets', 'src', 'main', 'sheets-main.ts'),
      '@matcha/sheets-save-runtime': join(genoffice, 'apps', 'sheets', 'src', 'main', 'sheets-main.ts'),
      '@matcha/pdf-dialog': join(root, 'src', 'pdf', 'dialog.ts'),
      '@matcha/pdf-image': join(root, 'src', 'pdf', 'image.ts'),
      '@matcha/pdf-main': join(genoffice, 'apps', 'pdf', 'src', 'main', 'pdf-main.ts'),
      '@matcha/slides-main': join(genoffice, 'apps', 'slides', 'src', 'main', 'slides-main.ts'),
      '@matcha/slides-session-state': join(genoffice, 'apps', 'slides', 'src', 'main', 'session-state.ts'),
      electron: join(root, 'src', 'platform', 'electron-main.ts')
    },
    external: ['jsdom', 'sharp'],
    loader: {
      '.md': 'text',
      '.png': 'dataurl',
      '.jpg': 'dataurl',
      '.jpeg': 'dataurl',
      '.gif': 'dataurl',
      '.webp': 'dataurl',
      '.svg': 'dataurl',
      '.ico': 'dataurl',
      '.ttf': 'dataurl',
      '.otf': 'dataurl',
      '.woff': 'dataurl',
      '.woff2': 'dataurl'
    },
    plugins: [patches.plugin, mermaidParser(patches), runtimeAssets(runtimeAssetFiles), officeDependencies(), genofficeResolver(), rawText(patches)]
  });
}

export async function buildPlugin({ platform = process.platform, arch = process.arch, outputDirectory = join(root, 'dist') } = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported Matcha Office target: ${platform}-${arch}.`);
  }
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.id !== id) throw new Error(`manifest.json must declare ${id}.`);
  const ajv = new Ajv({ strict: true, addUsedSchema: false });
  for (const tool of manifest.contributes.tools ?? []) {
    try {
      ajv.compile(tool.inputSchema);
      if (tool.outputSchema) ajv.compile(tool.outputSchema);
    } catch (error) {
      throw new Error(`Invalid JSON Schema for tool ${tool.name}: ${error.message}`, { cause: error });
    }
  }

  const sidecar = sidecarPath(platform);
  if (!(await exists(sidecar))) {
    throw new Error(`Missing xlsx sidecar: ${sidecar}. Build it with "cargo build --release --target-dir target" in apps/office/genoffice/apps/sheets/native/xlsx-engine, or set XLSX_SIDECAR_BIN.`);
  }
  assertNative(await readFile(sidecar), platform, sidecarName(platform));

  await mkdir(dirname(outputDirectory), { recursive: true });
  const output = await mkdtemp(join(dirname(outputDirectory), '.build-office-'));
  const runtimeAssetFiles = new Map();
  let patches;
  try {
    patches = await preparePatches(genoffice, dirname(requireFromHere.resolve('jsdom/package.json')));
    await mkdir(join(output, 'native'), { recursive: true });
    const backendBuild = await buildBackend(output, patches, runtimeAssetFiles);
    if (process.env.OFFICE_ARTIFACT_REPORT) await writeFile(`${process.env.OFFICE_ARTIFACT_REPORT}.backend.json`, JSON.stringify(backendBuild.metafile, null, 2) + '\n');
    await writeFile(join(output, 'main.cjs'), 'exports.activate = async function activate(context) { return (await import("./backend.mjs")).activate(context); };\n');
    for (const [relative, source] of runtimeAssetFiles) {
      const destination = join(output, 'native', relative);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    const harfbuzzRuntime = join(dirname(requireFromHere.resolve('harfbuzzjs')), 'harfbuzz.js');
    await mkdir(join(output, 'native', 'harfbuzz'), { recursive: true });
    await copyFile(harfbuzzRuntime, join(output, 'native', 'harfbuzz', 'harfbuzz.mjs'));
    await copyFile(requireFromHere.resolve('@embedpdf/pdfium/pdfium.wasm'), join(output, 'native', 'pdfium.wasm'));
    await copyFile(join(dirname(requireFromHere.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm'), join(output, 'native', 'hb-subset.wasm'));
    await copyFile(requireFromHere.resolve('@rhwp/core/rhwp_bg.wasm'), join(output, 'native', 'rhwp_bg.wasm'));
    if (platform === 'win32' || platform === 'darwin') {
      const helper = platform === 'win32' ? 'win-ocr.exe' : 'vision-ocr';
      const source = process.env.OFFICE_OCR_HELPER_BIN ?? join(genoffice, 'packages', 'pdf2docx', 'ocr-helper', helper);
      if (!(await exists(source))) throw new Error(`Missing Office OCR helper: ${source}. Supply a prebuilt helper with OFFICE_OCR_HELPER_BIN.`);
      await mkdir(join(output, 'native', 'ocr'), { recursive: true });
      await copyFile(source, join(output, 'native', 'ocr', helper));
    }
    await copySharpRuntime(join(output, 'node_modules'), platform, arch, patches);
    await copyJsdomTree(join(output, 'node_modules'), patches);
    await buildApplicationHtml(output, patches);
    await Promise.all([
      writeFile(join(output, 'manifest.json'), JSON.stringify(manifest) + '\n'),
      copyFile(join(genoffice, 'LICENSE'), join(output, 'LICENSE')),
      copyFile(join(genoffice, 'NOTICE'), join(output, 'NOTICE')),
      copyFile(sidecar, join(output, 'native', sidecarName(platform)))
    ]);
    await writeFile(
      join(output, 'BUILD.txt'),
      `Matcha Office ${manifest.version}\nTarget: ${platform}-${arch}\nGenOffice source overlay\nbackend: single ESM split build with CJS activate entry\nsheets save adapter: build-only exports from sheets-main (shared module)\nxlsx engine: xlsx-sidecar 0.1.0\nslides engine: bundled\n`
    );

    await assertArtifactBounds(output);
    const staged = await mkdtemp(join(dirname(outputDirectory), '.office-previous-'));
    const previous = join(staged, 'dist');
    let moved = false;
    try {
      await renameRetry(outputDirectory, previous);
      moved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await rm(staged, { recursive: true, force: true });
        throw error;
      }
    }
    try {
      await renameRetry(output, outputDirectory);
    } catch (error) {
      if (moved) await renameRetry(previous, outputDirectory);
      throw error;
    }
    await rm(staged, { recursive: true, force: true });
    console.log(`Built ${outputDirectory} for ${platform}-${arch}.`);
    return outputDirectory;
  } finally {
    try {
      await patches?.cleanup();
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPlugin();
