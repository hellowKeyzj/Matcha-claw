import { build } from 'esbuild';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(root, '.build-'));
try {
  await Promise.all([
    ...['esm', 'cjs'].map((format) => build({
      entryPoints: [join(root, 'src/index.ts')], outfile: join(temporary, `index.${format === 'esm' ? 'js' : 'cjs'}`),
      bundle: true, platform: 'neutral', format, target: 'es2022',
    })),
    build({ entryPoints: [join(root, 'src/package.ts')], outfile: join(temporary, 'package.js'), bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['fflate'] }),
  ]);
  const configPath = join(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, { outDir: temporary });
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  const emitted = program.emit();
  if (emitted.emitSkipped) throw new Error('SDK declaration generation failed.');
  await rm(join(root, 'dist'), { recursive: true, force: true });
  await rename(temporary, join(root, 'dist'));
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  console.log(`Built @matcha/app-plugins-sdk ${version}.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
await import('./pack-sdk.mjs');
