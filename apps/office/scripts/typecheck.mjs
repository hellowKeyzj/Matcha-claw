import ts from 'typescript';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { preparePatches } from './patches.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const patches = await preparePatches(join(root, 'genoffice'), dirname(require.resolve('jsdom/package.json')));
try {
  const configPath = join(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const source = (path) => join(root, path);
  const aliases = {
    '@matcha/sheets-app': ['genoffice/apps/sheets/src/renderer/App.tsx'],
    '@matcha/sheets-fonts': ['genoffice/apps/sheets/src/renderer/cell-font-fallback.ts'],
    '@matcha/sheets-locale': ['genoffice/apps/sheets/src/renderer/i18n/locale.tsx'],
    '@matcha/slides-app': ['genoffice/apps/slides/src/renderer/App.tsx'],
    '@matcha/slides-preload': ['genoffice/apps/slides/src/preload/index.ts']
  };
  const options = { ...parsed.options, types: ['node', 'vite/client', 'electron'], paths: { ...parsed.options.paths, ...aliases } };
  const contexts = [
    ['backend', 'src/activate.ts'],
    ...['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'].map((app) => [app, `src/${app}/page.tsx`]),
    ['conversion', 'src/conversion/worker.ts'],
    ['slides', 'src/slides/export-worker.ts'],
    ['docs', 'src/docs/headless-worker.tsx'],
    ['markdown', 'src/markdown/headless-worker.ts'],
    ['sheets', 'src/sheets/pdf-worker.tsx'],
    ['docs', 'genoffice/apps/docs/src/renderer/parse-worker.ts']
  ];
  const diagnostics = [...parsed.errors];
  const seen = new Set();
  // Each entry runs in its own Window; upstream apps intentionally use incompatible globals.
  for (const [app, entry] of contexts) {
    const declarations = parsed.fileNames.filter((path) => {
      const name = relative(root, path).split(sep).join('/');
      if (!name.endsWith('.d.ts') || name.endsWith('/renderer.d.ts')) return false;
      return name.startsWith(`src/${app}/`) || name === `genoffice/apps/${app}/src/renderer/env.d.ts`
        || name.endsWith('/src/main/env.d.ts') || name === 'src/renderer.d.ts';
    });
    const backendDeclarations = app === 'backend' ? [
      'genoffice/apps/docs/src/renderer/env.d.ts',
      'genoffice/apps/markdown/src/renderer/env.d.ts',
      'genoffice/apps/markdown/src/renderer/types/wavedrom.d.ts'
    ].map(source) : [];
    const roots = [source(entry), ...declarations, ...backendDeclarations, source('genoffice/packages/pdf2docx/src/bidi-js.d.ts'), join(root, '..', '..', 'sdk', 'app-plugins', 'src', 'reader.ts')].filter(existsSync);
    if (!existsSync(source(entry))) throw new Error(`Office typecheck entry is missing: ${entry}`);
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    host.readFile = (path) => patches.readFile(path) ?? readFile(path);
    const program = ts.createProgram(roots, options, host);
    const contextDiagnostics = ts.getPreEmitDiagnostics(program);
    if (contextDiagnostics.length) console.error(`Office typecheck entry ${entry}: ${contextDiagnostics.length} diagnostics`);
    for (const diagnostic of contextDiagnostics) {
      const key = `${diagnostic.file?.fileName}:${diagnostic.start}:${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push({ ...diagnostic, messageText: `[${entry}] ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}` });
      }
    }
  }
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n'
    }));
    process.exitCode = 1;
  }
} finally {
  await patches.cleanup();
}
