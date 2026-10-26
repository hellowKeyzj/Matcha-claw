import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

if (process.argv.length > 2 && (process.argv.length !== 4 || process.argv[2] !== '--root')) {
  throw new Error('Usage: node check-structure.mjs [--root <isolated-e2e-directory>]');
}
const root = process.argv[2] === '--root' ? path.resolve(process.argv[3]) : fileURLToPath(new URL('../', import.meta.url));
const src = path.join(root, 'src');
const suffixes = {
  abilities: 'ability', config: null, fixtures: null, interactions: 'interaction',
  pages: 'page', tasks: 'task', questions: 'question', scenarios: 'spec',
};
const errors = [];
let scenarioCount = 0;

function checkScenario(file, source) {
  const testNames = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/\/fixtures\/serenity\.(?:js|ts)$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (['test', 'it'].includes((binding.propertyName ?? binding.name).text)) testNames.add(binding.name.text);
    }
  }
  let hasCase = false;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && testNames.has(node.expression.text)) hasCase = true;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!hasCase) errors.push(`${file}: must contain a test(...) case imported from fixtures/serenity.js`);
}

function visit(directory, layer, depth = 0) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    const relative = path.relative(src, fullPath).replaceAll(path.sep, '/');
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      errors.push(`${relative}: symbolic links/junctions are forbidden in src`);
      continue;
    }
    if (stat.isDirectory()) {
      if (layer === 'config' || layer === 'fixtures' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
        errors.push(`${relative}: unapproved source directory`);
      }
      visit(fullPath, layer, depth + 1);
      continue;
    }
    if (entry.name === '.gitkeep' && depth === 0 && stat.isFile() && stat.size === 0) continue;
    const suffix = suffixes[layer];
    const expected = suffix ? new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*\\.${suffix}\\.ts$`)
      : new RegExp(`^${layer === 'config' ? 'electron' : 'serenity'}\\.ts$`);
    if (!stat.isFile() || !expected.test(entry.name)) {
      errors.push(`${relative}: wrong file name/type for ${layer}; no JS, declarations, JSX or alternate TS extensions`);
      continue;
    }
    const text = readFileSync(fullPath, 'utf8');
    const source = ts.createSourceFile(fullPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (source.parseDiagnostics.length) errors.push(`${relative}: TypeScript parse errors`);
    if (layer === 'scenarios') {
      scenarioCount += 1;
      checkScenario(relative, source);
    }
  }
}

if (!existsSync(src) || lstatSync(src).isSymbolicLink() || !lstatSync(src).isDirectory()) {
  errors.push('src must be a real directory');
} else {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!Object.hasOwn(suffixes, entry.name)) errors.push(`src/${entry.name}: unknown top-level source entry`);
  }
  for (const layer of Object.keys(suffixes)) {
    const directory = path.join(src, layer);
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
      errors.push(`src/${layer}: required real layer directory is missing`);
      continue;
    }
    visit(directory, layer);
  }
}
if (!scenarioCount) errors.push('src/scenarios must contain at least one *.spec.ts with a real case');
for (const required of ['fixtures/serenity.ts', 'config/electron.ts']) {
  if (!existsSync(path.join(src, required))) errors.push(`src/${required}: required central entry is missing`);
}

// Query only tracked legacy files; ignored local diagnostics are not part of this gate.
try {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'tests/e2e'], {
    cwd: path.dirname(root), encoding: 'utf8',
  }).split('\0').filter(Boolean);
  for (const file of tracked) {
    // Unstaged deletions remain in the index; the gate must not require git add.
    if (lstatSync(path.join(path.dirname(root), file), { throwIfNoEntry: false })) errors.push(`${file}: tracked legacy E2E files are forbidden; use e2e/src`);
  }
} catch (error) {
  errors.push(`Cannot check tracked legacy paths: ${error.message}`);
}

if (errors.length) {
  console.error(`E2E structure violations:\n${errors.map(error => ` - ${error}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`E2E structure passed (${scenarioCount} scenario files; no tracked legacy E2E files on disk).`);
}
