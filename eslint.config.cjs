// Run from the repository root:  npx eslint src
// Self-contained: no extra packages needed. Buffer and module only appear in the Node-compatible guards of pck.js and tres.js.
const browser = {};
['AbortController', 'CustomEvent', 'ImageData', 'MutationObserver', 'TextDecoder', 'clearTimeout', 'document', 'fetch', 'localStorage', 'navigator', 'setTimeout', 'window'].forEach(function (n) { browser[n] = 'readonly'; });
module.exports = [{
  files: ['**/*.js'],
  ignores: ['node_modules/**', 'tests/**', 'dist/**', 'src-tauri/**'],
  languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: Object.assign({}, browser, { Tres: 'writable', Pck: 'writable', VQTheme: 'readonly', Buffer: 'readonly', module: 'writable' }) },
  rules: {
    'no-undef': 'error', 'no-redeclare': 'error', 'no-dupe-keys': 'error', 'no-dupe-else-if': 'error', 'no-unreachable': 'warn', 'use-isnan': 'error', 'valid-typeof': 'error',
    'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-self-assign': 'warn', 'no-const-assign': 'error', 'no-func-assign': 'error', 'no-unsafe-finally': 'error',
    'no-sparse-arrays': 'warn', 'no-compare-neg-zero': 'warn', 'getter-return': 'error', 'no-async-promise-executor': 'error', 'no-cond-assign': ['warn', 'except-parens']
  }
}];
