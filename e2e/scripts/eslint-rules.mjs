import path from 'node:path';

const names = value => new Set(value.split(/\s+/).filter(Boolean));
const coreTypes = names(`Answerable Answered AnswersQuestions Expectation MetaQuestion MetaQuestionAdapter
  Optional QuestionAdapter RecursivelyAnswered WithAnswerableProperties`);
const coreQuestions = names('Question Check List Masked Numeric q d f format notepad notes isPresent');
const coreActivities = names('Task Interaction Check Wait Duration Loop Log');
const webLocators = names('By PageElement PageElements');
const webReads = names('Text Value Attribute CssClasses ComputedStyle Selected isActive isClickable isEnabled isSelected isVisible');
const webActions = names('Clear Click DoubleClick Drag Enter Hover Navigate Press RightClick Scroll Select Switch TakeScreenshot');
const nodeIO = names('node:fs node:fs/promises node:path node:url node:os node:net node:crypto node:events node:util node:timers/promises node:process');
const rawUI = names(`$ $$ locator getByRole getByText getByLabel getByTestId getByPlaceholder getByTitle getByAltText
  querySelector querySelectorAll getElementById getElementsByClassName getElementsByTagName
  evaluate evaluateHandle evaluateAll dispatchEvent waitForSelector waitForTimeout waitForFunction
  nativeElement nativePage nativeBrowser nativeBrowserContext executeScript executeAsyncScript
  click dblclick doubleClick rightClick fill type press pressSequentially tap check uncheck setChecked
  selectOption selectOptions setInputFiles dragTo dragAndDrop hover hoverOver enterValue clearValue
  scrollIntoView scrollIntoViewIfNeeded goto reload goBack goForward navigateTo switchTo
  screenshot takeScreenshot close launch launchPersistentContext newPage newContext connect connectOverCDP`);
const scenarioForbidden = new Set([...rawUI, ...names(`use extend skip fixme only parallel beforeAll afterAll beforeEach afterEach
  whoCan abilityTo initialise initialize dismiss discard configure engage actorCalled actorInTheSpotlight
  page browser context request electronApp sharedApp browserName playwright
  textContent innerText innerHTML outerHTML inputValue getAttribute setAttribute removeAttribute
  isVisible isEnabled isChecked isEditable count element elements located css xpath ofPage`)]);
const readOnlyForbidden = new Set([...rawUI, ...names('attemptsTo whoCan abilityTo initialise initialize dismiss discard using usingPage usingElectronApp')]);
const pageForbidden = new Set([...readOnlyForbidden, ...names(`answer answeredBy text value attribute html selectedOptions cssClasses computedStyle
  count isPresent isVisible isEnabled isSelected isActive isClickable isEditable isChecked`)]);
const forbiddenGlobals = names('process require module exports __dirname __filename Buffer global window document navigator localStorage sessionStorage fetch XMLHttpRequest WebSocket');

function propertyName(node) {
  if (!node) return undefined;
  if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return undefined;
}

function importedName(specifier) {
  return propertyName(specifier.imported);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function allowedExternal(layer, source, name, isType) {
  if (source === '@serenity-js/core') {
    if (coreTypes.has(name) && isType) return true;
    if (layer === 'pages') return names('d f format').has(name);
    if (layer === 'scenarios') return names('Check Wait Duration d f format').has(name);
    if (layer === 'questions') return coreQuestions.has(name);
    if (layer === 'tasks') return coreQuestions.has(name) || coreActivities.has(name);
    if (layer === 'interactions') return coreQuestions.has(name) || coreActivities.has(name) || (isType && name === 'Actor');
    if (layer === 'abilities') return names('Ability d f format').has(name) || (isType && names('Actor Initialisable Discardable').has(name));
    return layer === 'fixtures' && names('Actor Cast TakeNotes actorCalled configure d f format').has(name);
  }
  if (source === '@serenity-js/web') {
    if (layer === 'pages') return webLocators.has(name) || (isType && name === 'Selector');
    if (layer === 'questions') return webReads.has(name) || (isType && webLocators.has(name));
    if (layer === 'tasks' || layer === 'interactions') return webReads.has(name) || webActions.has(name) || (isType && webLocators.has(name));
    return false;
  }
  if (source === '@serenity-js/assertions') return names('scenarios tasks interactions').has(layer);
  if (source === '@serenity-js/playwright') return names('fixtures abilities').has(layer) && name === 'BrowseTheWebWithPlaywright';
  if (source === '@serenity-js/playwright-test') return layer === 'fixtures' && name === 'test';
  if (source === '@playwright/test' || source === 'playwright-core') {
    return (layer === 'abilities' && names('_electron chromium Browser BrowserContext ElectronApplication Page TestInfo WorkerInfo').has(name))
      || (layer === 'fixtures' && isType && names('Browser TestInfo WorkerInfo').has(name));
  }
  if (layer === 'abilities' && source === 'node:child_process') return name === 'execFile';
  if (layer === 'fixtures' && source === 'node:path') return name === 'join';
  if (layer === 'config') return (source === 'node:path' && names('resolve dirname join isAbsolute').has(name))
    || (source === 'node:url' && name === 'fileURLToPath');
  return layer === 'abilities' && nodeIO.has(source) && name !== 'createRequire';
}

export default {
  rules: {
    governance: {
      meta: {
        type: 'problem',
        schema: [{ type: 'object', properties: { root: { type: 'string' } }, required: ['root'], additionalProperties: false }],
        messages: {
          policy: '{{reason}}',
        },
      },
      create(context) {
        const sourceCode = context.sourceCode;
        const root = context.options[0].root;
        const src = path.join(root, 'src');
        const filename = context.filename;
        const layer = path.relative(src, filename).split(path.sep)[0];
        const report = (node, reason) => context.report({ node, messageId: 'policy', data: { reason } });
        const importedBindings = new Set();
        const forwardedBindings = new Set();
        const exportedDeclarations = [];
        const forbiddenProperties = layer === 'scenarios' ? scenarioForbidden
          : layer === 'pages' ? pageForbidden : layer === 'questions' ? readOnlyForbidden : undefined;

        function checkLocalImport(node, source) {
          if (!source.startsWith('.')) {
            report(node, `Only relative e2e/src imports and approved third-party named imports are allowed: ${source}`);
            return;
          }
          const target = path.resolve(path.dirname(filename), source);
          if (!isInside(src, target)) report(node, `Import escapes e2e/src: ${source}`);
          if (!/\.(?:js|ts)$/.test(source) || /\.(?:d\.ts|json|cjs|mjs)$/.test(source)) {
            report(node, `Use an explicit .js (NodeNext) or .ts source module path: ${source}`);
          }
        }

        function checkImport(node) {
          const source = node.source.value;
          for (const specifier of node.specifiers) importedBindings.add(specifier.local.name);
          if (source.startsWith('.') || source.startsWith('/') || /^[A-Za-z]:/.test(source)) {
            checkLocalImport(node, source);
            if (layer === 'scenarios' && /\/fixtures\//.test(source)) {
              for (const specifier of node.specifiers) {
                if (specifier.type !== 'ImportSpecifier' || !names('test it describe').has(importedName(specifier))) {
                  report(specifier, 'Scenarios may import only the fixture test API, not fixture setup or resources.');
                }
              }
            }
            return;
          }
          if (!node.specifiers.length) report(node, `Side-effect imports are not approved: ${source}`);
          for (const specifier of node.specifiers) {
            const name = importedName(specifier);
            const isType = node.importKind === 'type' || specifier.importKind === 'type';
            if (specifier.type !== 'ImportSpecifier' || !allowedExternal(layer, source, name, isType)) {
              report(specifier, `${layer} cannot import ${name ?? 'default/namespace'} from ${source}; use the owning layer.`);
            }
          }
        }

        function checkProperty(node, name) {
          if (forbiddenProperties?.has(name)) report(node, `${layer} cannot access "${name}"; move this operation to its owning layer.`);
        }

        return {
          Program(node) {
            for (const comment of sourceCode.getAllComments()) {
              if (/eslint-(?:disable|enable)|@ts-(?:ignore|nocheck|expect-error)/.test(comment.value)) {
                report(comment, 'Inline lint and TypeScript suppressions are forbidden.');
              }
            }
            if (!isInside(src, filename)) report(node, 'Source file is outside e2e/src.');
          },
          ImportDeclaration: checkImport,
          ImportExpression(node) {
            if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') {
              report(node, 'Dynamic imports must use a literal module path.');
              return;
            }
            if (!node.source.value.startsWith('.')) {
              report(node, 'Third-party modules require approved static named imports.');
              return;
            }
            checkLocalImport(node, node.source.value);
          },
          TSImportType(node) {
            const argument = node.argument ?? node.parameter;
            const literal = argument?.type === 'TSLiteralType' ? argument.literal : argument;
            if (literal?.type !== 'Literal' || typeof literal.value !== 'string') {
              report(node, 'Type imports must use a literal module path.');
            } else if (literal.value.startsWith('.')) {
              checkLocalImport(node, literal.value);
            } else {
              const qualifier = node.qualifier?.type === 'Identifier' ? node.qualifier.name : undefined;
              if (!allowedExternal(layer, literal.value, qualifier, true)) report(node, 'This third-party type import is not approved for this layer.');
            }
          },
          TSImportEqualsDeclaration(node) {
            report(node, 'Use static ES named imports, not import-equals/require.');
          },
          ExportAllDeclaration(node) {
            report(node, 'Re-exports hide layer ownership; import directly from the owning module.');
          },
          ExportNamedDeclaration(node) {
            if (node.source || node.specifiers.length) {
              report(node, 'Re-exports hide layer ownership; export declarations from their owning module.');
            }
            if (node.declaration) exportedDeclarations.push(node.declaration);
          },
          ExportDefaultDeclaration(node) {
            report(node, 'Use named declarations, not default exports or forwarding barrels.');
          },
          VariableDeclarator(node) {
            if (node.id.type === 'Identifier' && node.init?.type === 'Identifier') forwardedBindings.add([node.id.name, node.init.name]);
          },
          MemberExpression(node) {
            const name = propertyName(node.property);
            if (names('require createRequire getBuiltinModule').has(name)) report(node, 'Runtime module loading bypasses the dependency graph.');
            if (names('scenarios pages questions tasks interactions').has(layer) && forbiddenGlobals.has(name)) {
              report(node, `${layer} cannot access ${name}; use an Ability or Fixture.`);
            }
            if (node.computed && node.property.type !== 'Literal') {
              if (names('scenarios pages questions').has(layer)) report(node, 'Computed member access must use a literal key in this layer.');
              return;
            }
            checkProperty(node, propertyName(node.property));
          },
          Property(node) {
            if (node.parent.type === 'ObjectPattern') checkProperty(node, propertyName(node.key));
          },
          'Program:exit'() {
            for (const scope of sourceCode.scopeManager.scopes) {
              for (const reference of scope.references) {
                const { identifier, resolved } = reference;
                if (identifier.name === 'require' || identifier.name === 'eval' || identifier.name === 'Function') {
                  report(identifier, 'Runtime require and code generation bypass the dependency graph.');
                }
                if (!resolved && names('scenarios pages questions tasks interactions').has(layer) && forbiddenGlobals.has(identifier.name)) {
                  report(identifier, `${layer} cannot use global ${identifier.name}; use an Ability or Fixture.`);
                }
              }
            }
            let hasChanges = true;
            while (hasChanges) {
              hasChanges = false;
              for (const [target, source] of forwardedBindings) {
                if (importedBindings.has(source) && !importedBindings.has(target)) {
                  importedBindings.add(target);
                  hasChanges = true;
                }
              }
            }
            for (const declaration of exportedDeclarations) {
              for (const entry of declaration.declarations ?? []) {
                if (entry.init?.type === 'Identifier' && importedBindings.has(entry.init.name)) {
                  report(entry, 'Do not forward an imported binding under a new export; preserve layer ownership.');
                }
              }
            }
          },
        };
      },
    },
  },
};
