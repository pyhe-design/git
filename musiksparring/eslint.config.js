import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  { ignores: ['node_modules/**', 'vendor/**', 'dist/**'] },
  {
    files: ['src/**/*.js', 'sdk/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.node,
        preact: 'readonly',
        preactHooks: 'readonly',
        htm: 'readonly',
        MusikAI: 'readonly',
        Theory: 'readonly',
        AudioKit: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'sdk/examples/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, document: 'readonly' } },
  },
];
