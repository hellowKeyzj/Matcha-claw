import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { configFor } from '../eslint.config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'matchaclaw-e2e-policy-'));
const layers = ['abilities', 'config', 'fixtures', 'interactions', 'pages', 'tasks', 'questions', 'scenarios'];
const suffix = { abilities: 'ability', config: 'ts', fixtures: 'ts', interactions: 'interaction', pages: 'page', tasks: 'task', questions: 'question', scenarios: 'spec' };
const files = [];

function add(layer, name, code, rule) {
  const file = path.join(temporaryRoot, 'src', layer, `${name}.${suffix[layer] === 'ts' ? 'ts' : `${suffix[layer]}.ts`}`);
  writeFileSync(file, code);
  files.push({ file, name, rule });
}

try {
  writeFileSync(path.join(temporaryRoot, 'tsconfig.json'), readFileSync(path.join(root, 'tsconfig.json')));
  for (const layer of layers) {
    mkdirSync(path.join(temporaryRoot, 'src', layer), { recursive: true });
    const file = layer === 'config' ? 'electron.ts' : layer === 'fixtures' ? 'serenity.ts' : `sample.${suffix[layer]}.ts`;
    writeFileSync(path.join(temporaryRoot, 'src', layer, file), 'export const sample = 1;\n');
  }

  // These allowed edges are deliberately independent of the production whitelist table.
  const allowed = {
    scenarios: ['fixtures', 'tasks', 'questions'], tasks: ['tasks', 'interactions', 'pages', 'questions'],
    questions: ['questions', 'pages'], interactions: ['interactions', 'pages', 'abilities'],
    pages: ['pages'], fixtures: ['fixtures', 'config', 'abilities'], abilities: ['abilities', 'config'], config: ['config'],
  };
  for (const from of layers) {
    for (const to of layers) {
      const target = to === 'config' ? 'electron.js' : to === 'fixtures' ? 'serenity.js' : `sample.${suffix[to]}.js`;
      const binding = from === 'scenarios' && to === 'fixtures' ? 'test' : 'sample';
      if (binding === 'test') writeFileSync(path.join(temporaryRoot, 'src', 'fixtures', 'serenity.ts'), 'export const test = () => {};\n');
      add(from, `edge-${to}`, `import { ${binding} } from '../${to}/${target}'; void ${binding};`,
        allowed[from].includes(to) ? undefined : 'boundaries/dependencies');
    }
  }

  add('scenarios', 'valid-business', `import { test as scenario } from '../fixtures/serenity.js';
    import { Ensure, equals } from '@serenity-js/assertions';
    import { sample as task } from '../tasks/sample.task.js';
    scenario('business result', async ({ actor }) => { await actor.attemptsTo(task, Ensure.that(1, equals(1))); });`);
  add('pages', 'valid-locator', `import { By, PageElement } from '@serenity-js/web';
    export const heading = () => PageElement.located(By.css('h1')).describedAs('heading');`);
  add('questions', 'valid-read', `import { Question } from '@serenity-js/core'; import { Text } from '@serenity-js/web';
    import { sample } from '../pages/sample.page.js'; export const title = () => Question.about('title', actor => actor.answer(Text.of(sample)));`);
  add('tasks', 'valid-ui', `import { Task } from '@serenity-js/core'; import { Click } from '@serenity-js/web';
    import { sample } from '../pages/sample.page.js'; export const submit = () => Task.where('submit', Click.on(sample));`);
  add('abilities', 'valid-io', `import { Ability } from '@serenity-js/core'; import { mkdtemp } from 'node:fs/promises';
    export class UseProfile extends Ability { create() { return mkdtemp('profile-'); } }`);
  add('config', 'valid-path', `import { resolve } from 'node:path'; export const binary = resolve('app');`);
  add('abilities', 'valid-tool-probe', `import { execFile } from 'node:child_process'; void execFile;`);

  const governance = 'e2e/governance';
  const invalid = [
    ['scenarios', 'raw-runner', `import { test } from '@playwright/test'; void test;`],
    ['scenarios', 'raw-browser-type', `import type { Page } from 'playwright-core'; export type Raw = Page;`],
    ['scenarios', 'raw-electron', `import { app } from 'electron'; void app;`],
    ['scenarios', 'raw-filesystem', `import { readFile } from 'node:fs/promises'; void readFile;`],
    ['scenarios', 'raw-process', `process.exit(0);`],
    ['scenarios', 'raw-process-member', `globalThis.process.exit(0);`],
    ['scenarios', 'locator-call', `export const run = actor => actor.getByRole('button').click();`],
    ['scenarios', 'dom-call', `document.querySelector('button');`],
    ['scenarios', 'actor-build', `import { actorCalled as build } from '@serenity-js/core'; void build;`],
    ['scenarios', 'actor-setup', `export const run = borrowed => borrowed.whoCan('other');`],
    ['scenarios', 'raw-fixture-destructure', `export const run = ({ page: borrowed }) => borrowed;`],
    ['scenarios', 'raw-fixture-member', `export const run = fixture => fixture.page;`],
    ['scenarios', 'test-use-alias', `import { test as scenario } from '../fixtures/serenity.js'; scenario.use({});`],
    ['scenarios', 'test-extend', `import { test } from '../fixtures/serenity.js'; test.extend({});`],
    ['scenarios', 'test-only', `import { test } from '../fixtures/serenity.js'; test.only('case', () => {});`],
    ['scenarios', 'test-parallel', `import { test } from '../fixtures/serenity.js'; test.describe.parallel('group', () => {});`],
    ['scenarios', 'test-fixme', `import { test } from '../fixtures/serenity.js'; test.fixme();`],
    ['scenarios', 'test-skip-computed', `import { test as it } from '../fixtures/serenity.js'; it['skip']();`],
    ['scenarios', 'test-skip-destructured', `import { test } from '../fixtures/serenity.js'; const { skip: omit } = test; omit();`],
    ['scenarios', 'test-computed-variable', `import { test } from '../fixtures/serenity.js'; const key = 'skip'; test[key]();`],
    ['scenarios', 'fixture-resource-import', `import { sharedApp } from '../fixtures/serenity.js'; void sharedApp;`],
    ['scenarios', 'inline-disable', `// eslint-disable-next-line e2e/governance\nexport const value = 1;`],
    ['scenarios', 'ts-ignore', `// @ts-ignore\nexport const value = 1;`],
    ['scenarios', 'ts-nocheck', `// @ts-nocheck\nexport const value = 1;`],
    ['scenarios', 'ts-expect-error', `// @ts-expect-error\nexport const value = 1;`],
    ['pages', 'action-import', `import { Click as Action } from '@serenity-js/web'; void Action;`],
    ['pages', 'navigation-import', `import { Navigate } from '@serenity-js/web'; void Navigate;`],
    ['pages', 'browse-import', `import { BrowseTheWeb } from '@serenity-js/web'; void BrowseTheWeb;`],
    ['pages', 'locator-action', `import { By, PageElement } from '@serenity-js/web'; PageElement.located(By.css('button')).click();`],
    ['pages', 'locator-read', `import { By, PageElement } from '@serenity-js/web'; PageElement.located(By.css('h1')).text();`],
    ['questions', 'action-import', `import { Enter } from '@serenity-js/web'; void Enter;`],
    ['questions', 'locator-action', `export const read = element => element.click();`],
    ['questions', 'native-escape', `export const read = element => element.nativeElement();`],
    ['pages', 'namespace-import', `import * as web from '@serenity-js/web'; void web;`],
    ['pages', 'default-import', `import web from '@serenity-js/web'; void web;`],
    ['tasks', 'unapproved-library', `import { readFile } from 'fs'; void readFile;`],
    ['tasks', 'raw-process-launch', `import { execFile } from 'node:child_process'; void execFile;`],
    ['config', 'unapproved-serenity', `import { Task } from '@serenity-js/core'; void Task;`],
    ['fixtures', 'private-scene-metadata', `import { SceneTagged } from '@serenity-js/core/events'; void SceneTagged;`],
    ['fixtures', 'private-browser-metadata', `import { BrowserTag } from '@serenity-js/core/model'; void BrowserTag;`],
    ['pages', 'locator-presence-read', `export const locator = element => element.isPresent();`],
    ['abilities', 'create-require', `import { createRequire as loader } from 'node:module'; void loader;`],
    ['abilities', 'require-alias', `const load = require; load('node:fs');`],
    ['fixtures', 'module-require', `module.require('node:fs');`],
    ['config', 'process-loader', `process.getBuiltinModule('fs');`],
    ['tasks', 'nonliteral-import', `const name = '../pages/sample.page.js'; void import(name);`],
    ['tasks', 'template-import', 'void import(`../pages/sample.page.js`);'],
    ['tasks', 'external-dynamic-import', `void import('@serenity-js/web');`],
    ['tasks', 'playwright-dynamic-import', `void import('playwright-core');`],
    ['tasks', 'outside-source', `import { value } from '../../../src/app.js'; void value;`],
    ['tasks', 'absolute-source', `import { value } from '/other/src/app.js'; void value;`],
    ['tasks', 'project-alias', `import { value } from '@/pages/app'; void value;`],
    ['tasks', 'export-star', `export * from '../pages/sample.page.js';`],
    ['tasks', 'export-named', `export { sample } from '../pages/sample.page.js';`],
    ['tasks', 'export-type', `export type { sample } from '../pages/sample.page.js';`],
    ['tasks', 'export-forward', `import { sample } from '../pages/sample.page.js'; export const Forward = sample;`],
    ['tasks', 'export-alias', `import { sample } from '../pages/sample.page.js'; const copy = sample; export const Forward = copy;`],
    ['tasks', 'export-namespace', `export * as Pages from '../pages/sample.page.js';`],
    ['tasks', 'generated-code', `const load = Function('return 1'); void load;`],
  ];
  for (const [layer, name, code] of invalid) add(layer, name, code, governance);
  add('scenarios', 'type-boundary', `import type { sample } from '../pages/sample.page.js'; export type Copy = typeof sample;`, 'boundaries/dependencies');
  add('scenarios', 'type-expression-boundary', `export type Copy = typeof import('../pages/sample.page.js').sample;`, 'boundaries/dependencies');
  add('scenarios', 'dynamic-boundary', `void import('../pages/sample.page.js');`, 'boundaries/dependencies');
  add('tasks', 'unknown-dependency', `import { value } from '../unknown/value.js'; void value;`, 'boundaries/no-unknown-dependencies');
  mkdirSync(path.join(temporaryRoot, 'src', 'unknown'));
  const unknownFile = path.join(temporaryRoot, 'src', 'unknown', 'value.ts');
  writeFileSync(unknownFile, 'export const value = 1;');
  files.push({ file: unknownFile, name: 'unknown-file', rule: 'boundaries/no-unknown-files' });

  const eslint = new ESLint({ cwd: temporaryRoot, overrideConfigFile: true, overrideConfig: configFor(temporaryRoot) });
  const results = await eslint.lintFiles(files.map(entry => entry.file));
  for (const entry of files) {
    const result = results.find(result => result.filePath === entry.file);
    assert.ok(result, `${entry.name}: no lint result`);
    assert.ok(!result.messages.some(message => message.fatal || /Definition for rule .* was not found/.test(message.message)),
      `${entry.name}: parser or missing-rule failure is not policy enforcement`);
    if (entry.rule) {
      assert.ok(result.messages.some(message => message.ruleId === entry.rule && message.severity === 2),
        `${entry.name}: expected ${entry.rule} error, received ${JSON.stringify(result.messages)}`);
    } else {
      assert.deepEqual(result.messages, [], `${entry.name}: valid code must pass`);
    }
  }
  const inlineConfig = await eslint.calculateConfigForFile(path.join(temporaryRoot, 'src', 'scenarios', 'sample.spec.ts'));
  assert.equal(inlineConfig.linterOptions.noInlineConfig, true);
  assert.equal(inlineConfig.linterOptions.reportUnusedDisableDirectives, 2);
  const structureRepository = path.join(temporaryRoot, 'structure-repository');
  const structureRoot = path.join(structureRepository, 'e2e');
  const structureSource = path.join(structureRoot, 'src');
  mkdirSync(structureSource, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: structureRepository });
  for (const layer of layers) mkdirSync(path.join(structureSource, layer));
  writeFileSync(path.join(structureSource, 'fixtures', 'serenity.ts'), 'export const test = () => {};');
  writeFileSync(path.join(structureSource, 'config', 'electron.ts'), 'export const binary = "app";');
  const scenarioFile = path.join(structureSource, 'scenarios', 'sample.spec.ts');
  const validScenario = `import { test } from '../fixtures/serenity.js'; test('case', () => {});`;
  writeFileSync(scenarioFile, validScenario);
  const structureScript = path.join(root, 'scripts', 'check-structure.mjs');
  let structureCases = 0;
  function checkStructure(expectedError) {
    const result = spawnSync(process.execPath, [structureScript, '--root', structureRoot], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, expectedError ? 1 : 0, `${expectedError ?? 'valid structure'}: ${result.stdout}\n${result.stderr}`);
    if (expectedError) assert.ok(result.stderr.includes(expectedError), `${expectedError}: missing diagnostic in ${result.stderr}`);
    structureCases += 1;
  }
  checkStructure();
  const wrongFile = path.join(structureSource, 'pages', 'bypass.js');
  writeFileSync(wrongFile, 'export const bypass = true;');
  checkStructure('wrong file name/type for pages');
  rmSync(wrongFile);
  const unknownDirectory = path.join(structureSource, 'unknown');
  mkdirSync(unknownDirectory);
  checkStructure('unknown top-level source entry');
  rmSync(unknownDirectory, { recursive: true });
  const missingLayer = path.join(structureSource, 'interactions');
  rmSync(missingLayer, { recursive: true });
  checkStructure('required real layer directory is missing');
  mkdirSync(missingLayer);
  writeFileSync(scenarioFile, 'export const noCase = true;');
  checkStructure('must contain a test(...) case');
  writeFileSync(scenarioFile, validScenario);
  const linkedDirectory = path.join(structureSource, 'pages', 'linked');
  symlinkSync(path.join(structureSource, 'config'), linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  checkStructure('symbolic links/junctions are forbidden');
  rmSync(linkedDirectory, { recursive: true });
  const legacyDirectory = path.join(structureRepository, 'tests', 'e2e');
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(path.join(legacyDirectory, 'local-ignored.spec.ts'), 'local diagnosis');
  writeFileSync(path.join(structureRepository, '.gitignore'), 'tests/e2e/local-ignored.spec.ts\n');
  checkStructure();
  const newLegacyFile = path.join(legacyDirectory, 'new.spec.ts');
  writeFileSync(newLegacyFile, 'new tracked legacy case');
  execFileSync('git', ['add', '--', 'tests/e2e/new.spec.ts'], { cwd: structureRepository });
  checkStructure('tests/e2e/new.spec.ts: tracked legacy E2E files are forbidden');
  rmSync(newLegacyFile);
  assert.equal(execFileSync('git', ['ls-files', '--', 'tests/e2e/new.spec.ts'], { cwd: structureRepository, encoding: 'utf8' }).trim(),
    'tests/e2e/new.spec.ts', 'unstaged deletion must still be tracked');
  checkStructure();
  for (const file of ['app-smoke.spec.ts', 'chat/chat.spec.ts', 'settings-proxy.spec.ts', 'fixtures/electron.ts']) {
    const legacyFile = path.join(legacyDirectory, file);
    mkdirSync(path.dirname(legacyFile), { recursive: true });
    writeFileSync(legacyFile, 'formerly allowed tracked legacy file');
    execFileSync('git', ['add', '--', `tests/e2e/${file}`], { cwd: structureRepository });
    checkStructure(`tests/e2e/${file}: tracked legacy E2E files are forbidden`);
    rmSync(legacyFile);
    checkStructure();
  }
  console.log(`E2E enforcement passed (${files.length} real-lint cases, all 64 layer edges; ${structureCases} structure cases).`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
