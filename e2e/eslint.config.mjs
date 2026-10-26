import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import governance from './scripts/eslint-rules.mjs';

export const allowedDependencies = {
  scenarios: ['fixtures', 'tasks', 'questions'],
  tasks: ['tasks', 'interactions', 'pages', 'questions'],
  questions: ['questions', 'pages'],
  interactions: ['interactions', 'pages', 'abilities'],
  pages: ['pages'],
  fixtures: ['fixtures', 'config', 'abilities'],
  abilities: ['abilities', 'config'],
  config: ['config'],
};

// The self-check supplies its own temporary src; production always uses this directory.
export function configFor(root) {
  return [
    { ignores: ['node_modules/**', 'reports/**', 'test-results/**', 'playwright-report/**'] },
    ...tseslint.configs.recommended.map(config => ({ ...config, files: ['src/**/*.ts'] })),
    {
      files: ['src/**/*.ts'],
      linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
      plugins: { boundaries, e2e: governance },
      settings: {
        'boundaries/root-path': root,
        'boundaries/elements': Object.keys(allowedDependencies).map(type => ({ type, pattern: `src/${type}`, partialMatch: false })),
        'boundaries/additional-dependency-nodes': [
          { selector: 'TSImportType > Literal', kind: 'type', name: 'ts-import-type' },
        ],
        'import/resolver': { typescript: { project: path.join(root, 'tsconfig.json') } },
      },
      rules: {
        '@typescript-eslint/no-require-imports': 'error',
        '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': true }],
        'boundaries/no-unknown-files': 'error',
        'boundaries/no-unknown-dependencies': ['error', { require: 'element' }],
        'boundaries/dependencies': ['error', {
          default: 'disallow',
          checkInternals: true,
          checkUnknownLocals: true,
          policies: Object.entries(allowedDependencies).map(([from, to]) => ({
            from: { element: { type: from } },
            allow: { to: { element: { type: to } } },
          })),
        }],
        'e2e/governance': ['error', { root }],
      },
    },
  ];
}

export default configFor(fileURLToPath(new URL('.', import.meta.url)));
