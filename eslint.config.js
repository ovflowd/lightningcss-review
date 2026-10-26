/**
 * ESLint flat config. The whole tree passes with zero warnings (`npm run lint`).
 *
 * - Host code (lib/, bin/lcr, scripts/, test/) and the analysis-image oracle scripts (oracle/*.mjs)
 *   are modern ESM for Node >= 24.
 * - The engine runner (oracle/engine-runner.cjs and oracle/runner/) runs inside legacy Playwright
 *   images with Node 14/16: CommonJS, ES2020 syntax, no `node:` specifiers and none of the newer
 *   built-ins listed below.
 * - Vendored files (oracle/wpt/) keep their upstream style and are not linted.
 *
 * `no-undef` is off for type-checked files: `tsc --checkJs` reports undefined names with the right
 * globals for each file (Node, DOM in page code), which a fixed ESLint globals list cannot.
 */
import { builtinModules } from 'node:module';

import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';

/** Node core modules, bare (`fs`): host code imports them as `node:fs`. */
const BARE_BUILTINS = builtinModules.filter((name) => !name.startsWith('_') && !name.startsWith('node:'));

/** Built-ins newer than Node 14 that the engine runner must not use. */
const NEWER_THAN_NODE_14 = [
  { object: 'Object', property: 'hasOwn', message: 'Node 16.9+; use Object.prototype.hasOwnProperty.call.' },
  { property: 'at', message: 'Node 16.6+; index explicitly.' },
  { property: 'replaceAll', message: 'Node 15+; use replace with a global regex.' },
  { property: 'findLast', message: 'Node 18+.' },
  { property: 'findLastIndex', message: 'Node 18+.' },
  { object: 'AbortSignal', property: 'timeout', message: 'Node 16.14+.' },
];

const BLANK_LINES = [
  { blankLine: 'always', prev: '*', next: ['return', 'block-like', 'throw'] },
  { blankLine: 'always', prev: 'block-like', next: '*' },
  { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
  { blankLine: 'any', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
  { blankLine: 'always', prev: 'directive', next: '*' },
  { blankLine: 'always', prev: 'import', next: '*' },
  { blankLine: 'any', prev: 'import', next: 'import' },
];

const BARE_BUILTIN_PATHS = BARE_BUILTINS.map((name) => ({ name, message: `Import 'node:${name}'.` }));

const MAX_FUNCTION_LINES = 60;
const MAX_COMPLEXITY = 15;
const MAX_DEPTH = 4;

export default [
  {
    ignores: ['node_modules/**', 'oracle/wpt/**'],
  },
  js.configs.recommended,
  jsdoc.configs['flat/recommended-typescript-flavor-error'],
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs', 'bin/lcr'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-nested-ternary': 'error',
      'max-depth': ['error', MAX_DEPTH],
      complexity: ['error', MAX_COMPLEXITY],
      'max-lines-per-function': [
        'error',
        { max: MAX_FUNCTION_LINES, skipBlankLines: true, skipComments: true },
      ],
      'padding-line-between-statements': ['error', ...BLANK_LINES],
      eqeqeq: ['error', 'always'],
      // One style across host and oracle code: every body in braces, so a block is never one
      // edit away from silently losing its scope.
      curly: ['error', 'all'],
      // Tools that write files can turn `\u00a0`-style escapes into the raw characters; keep
      // invisible characters out of strings and regexes too.
      'no-irregular-whitespace': [
        'error',
        { skipStrings: false, skipComments: false, skipRegExps: false, skipTemplates: false },
      ],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'no-restricted-imports': ['error', { paths: BARE_BUILTIN_PATHS }],
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: { FunctionDeclaration: true, ClassDeclaration: true, MethodDefinition: false },
          contexts: ['ExportNamedDeclaration > VariableDeclaration'],
        },
      ],
      // An export says what it is for; parameters and return values may rely on their types.
      'jsdoc/require-description': [
        'error',
        {
          contexts: [
            'ExportNamedDeclaration > FunctionDeclaration',
            'ExportNamedDeclaration > ClassDeclaration',
            'ExportNamedDeclaration > VariableDeclaration',
          ],
        },
      ],
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/require-property-description': 'off',
      // Types are checked by tsc (checkJs), which knows imported and global types.
      'jsdoc/no-undefined-types': 'off',
      'jsdoc/tag-lines': ['error', 'any', { startLines: 1 }],
    },
  },
  {
    // Host code: output goes through core/log.js, processes through core/proc.js.
    files: ['lib/**/*.js', 'scripts/**/*.js'],
    ignores: ['lib/core/proc.js', '**/test/**'],
    rules: {
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...BARE_BUILTIN_PATHS,
            {
              name: 'node:child_process',
              message: 'Start processes with lib/core/proc.js (run, runSync, LineProcess).',
            },
          ],
        },
      ],
    },
  },
  {
    // bin/lcr has no `.js` extension, so tsc does not check it; ESLint catches undefined names.
    files: ['bin/lcr'],
    languageOptions: { globals: { process: 'readonly' } },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['oracle/engine-runner.cjs', 'oracle/runner/**/*.cjs'],
    languageOptions: { ecmaVersion: 2020, sourceType: 'commonjs' },
    rules: {
      // The `node:` rule above is for ESM imports; the runner requires bare names on purpose.
      'no-restricted-imports': 'off',
      'no-restricted-properties': ['error', ...NEWER_THAN_NODE_14],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require'] > Literal[value=/^node:/]",
          message: "Node 14.0-14.17 cannot require 'node:' specifiers; use the bare name.",
        },
      ],
    },
  },
  {
    // Tests are long linear scripts over loosely typed fixtures.
    files: ['**/test/**/*.{js,mjs,cjs}', 'test/**/*.js'],
    rules: { 'max-lines-per-function': 'off', 'jsdoc/reject-any-type': 'off' },
  },
];
