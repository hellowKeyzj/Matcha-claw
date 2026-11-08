import { build } from 'esbuild';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateAppPluginManifest } from '../dist/package.js';
import { packDirectory } from './pack.mjs';

function projectPath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Build paths must be relative project paths without links or parent traversal.');
  }
  const result = resolve(root, path);
  if (!result.startsWith(`${root}${sep}`)) throw new Error('Build path is outside the project.');
  return result;
}

async function sourcePath(root, path) {
  const source = projectPath(root, path);
  if ((await realpath(source)) !== source || !(await lstat(source)).isFile()) throw new Error(`Build input must be a regular project file: ${path}`);
  return source;
}

const resourceLoaders = Object.fromEntries(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'otf'].map((extension) => [`.${extension}`, 'dataurl']));
const noNetwork = { name: 'local-input-only', setup(builder) {
  builder.onResolve({ filter: /^(?:https?:|\/\/)/i }, ({ path }) => ({ errors: [{ text: `External build resources are not supported: ${path}` }] }));
} };

export async function buildHtml({ root, source, minify = true }) {
  root = await realpath(resolve(root));
  const input = await sourcePath(root, source);
  let html = await readFile(input, 'utf8');
  const directory = dirname(input);
  async function resolveReference(reference) {
    if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(reference) || /[?#]/.test(reference)) throw new Error(`HTML resources must use local relative paths: ${reference}`);
    const path = relative(root, resolve(directory, reference)).split(sep).join('/');
    return sourcePath(root, path);
  }
  async function compile(reference, platform = 'browser') {
    const entry = await resolveReference(reference);
    return build({
      entryPoints: [entry], outfile: join(root, '.matcha-inline.js'), bundle: true, platform, format: 'iife', target: 'chrome140',
      minify, write: false, loader: resourceLoaders, plugins: [noNetwork],
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  }
  const attribute = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  for (const match of [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*["'][^>]*>\s*<\/script\s*>/gi)]) {
    const output = await compile(attribute(match[0], 'src'));
    const script = output.outputFiles.find((file) => file.path.endsWith('.js'))?.text;
    if (!script) throw new Error('HTML build produced no JavaScript.');
    const css = output.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
    html = html.replace(match[0], () => `${css ? `<style>${css.replaceAll('</style', '<\\/style')}</style>` : ''}<script>${script.replaceAll('</script', '<\\/script')}</script>`);
  }
  for (const match of [...html.matchAll(/<link\b[^>]*>/gi)]) {
    if (attribute(match[0], 'rel')?.toLowerCase() !== 'stylesheet') throw new Error('Self-contained HTML only supports stylesheet links.');
    const entry = await resolveReference(attribute(match[0], 'href'));
    const output = await build({ entryPoints: [entry], bundle: true, write: false, minify, loader: resourceLoaders, plugins: [noNetwork] });
    html = html.replace(match[0], () => `<style>${output.outputFiles[0].text.replaceAll('</style', '<\\/style')}</style>`);
  }
  const imageMime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  for (const match of [...html.matchAll(/<(?:img|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]) {
    if (/^(?:data:|blob:)/i.test(match[1])) continue;
    const entry = await resolveReference(match[1]);
    const mime = imageMime[extname(entry).toLowerCase()];
    if (!mime) throw new Error('Inline HTML images must use a supported image format.');
    const data = `data:${mime};base64,${(await readFile(entry)).toString('base64')}`;
    html = html.replace(match[0], () => match[0].replace(match[1], data));
  }
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const cssUrls = [...markup.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)];
  const sources = [...markup.matchAll(/\bsrc\s*=\s*["']([^"']*)["']/gi)];
  if (/<script\b[^>]*\bsrc\s*=/i.test(html) || /<(?:base|iframe|frame|object|embed)\b/i.test(markup)
    || /\bsrcset\s*=/i.test(markup) || /@import\s/i.test(markup)
    || cssUrls.some((match) => !/^(?:data:|blob:|#)/i.test(match[1]))
    || sources.some((match) => !/^(?:data:|blob:)/i.test(match[1]))) {
    throw new Error('HTML must be self-contained; use imported CSS/assets and local script entries.');
  }
  return html;
}

export async function buildProject(directory = process.cwd()) {
  const root = await realpath(resolve(directory));
  const manifest = validateAppPluginManifest(JSON.parse(await readFile(await sourcePath(root, 'manifest.json'), 'utf8')));
  const config = JSON.parse(await readFile(await sourcePath(root, 'app-plugin.build.json'), 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some((key) => !['backend', 'html', 'assets'].includes(key))) throw new Error('Invalid app-plugin.build.json.');
  const temporary = await mkdtemp(join(root, '.matcha-build-'));
  const output = join(root, 'dist');
  let backup;
  let canRemoveBackup = false;
  try {
    const written = new Set(['manifest.json']);
    async function destination(path) {
      const target = projectPath(temporary, path);
      if (written.has(path.toLowerCase())) throw new Error(`Duplicate build output: ${path}`);
      written.add(path.toLowerCase());
      await mkdir(dirname(target), { recursive: true });
      return target;
    }
    if (config.backend !== undefined) {
      if (!manifest.main) throw new Error('A TypeScript backend build requires manifest.main.');
      await build({ entryPoints: [await sourcePath(root, config.backend)], outfile: await destination(manifest.main), bundle: true, platform: 'node', format: 'cjs', target: 'node22', plugins: [noNetwork] });
    }
    for (const key of ['html', 'assets']) {
      const entries = config[key] ?? {};
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`Build ${key} must map package paths to project files.`);
      for (const [path, source] of Object.entries(entries)) {
        const target = await destination(path);
        if (key === 'html') await writeFile(target, await buildHtml({ root, source }));
        else await copyFile(await sourcePath(root, source), target);
      }
    }
    await writeFile(join(temporary, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    const contents = await packDirectory(temporary);
    if (await lstat(output).catch((error) => { if (error.code !== 'ENOENT') throw error; })) {
      backup = await mkdtemp(join(root, '.matcha-previous-'));
      await rename(output, join(backup, 'dist'));
    }
    try {
      await rename(temporary, output);
      canRemoveBackup = true;
    } catch (error) {
      if (backup) {
        await rename(join(backup, 'dist'), output);
        canRemoveBackup = true;
      }
      throw error;
    }
    return { directory: output, ...contents };
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (backup && canRemoveBackup) await rm(backup, { recursive: true, force: true });
  }
}
