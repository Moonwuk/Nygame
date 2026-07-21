// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Determinism: these Math functions are "implementation-approximated" in ECMA-262
 * (not required to be correctly-rounded), so they can differ bit-for-bit across JS
 * engines (V8 on the server vs V8 / JSC / Hermes on the client) — which would
 * desync the client's preview from the server authority. The core must stay in the
 * correctly-rounded IEEE-754 subset (+ − × ÷ √ min max floor ceil + integer ops).
 * `Math.sqrt` is intentionally NOT banned: IEEE-754 mandates √ be correctly rounded
 * and ECMA-262 excludes it from the approximated list. See docs/architecture.md §8.
 */
const NON_DETERMINISTIC_MATH = [
  'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'cbrt', 'cos', 'cosh',
  'exp', 'expm1', 'hypot', 'log', 'log10', 'log1p', 'log2', 'pow', 'sin', 'sinh', 'tan', 'tanh',
].map((property) => ({
  object: 'Math',
  property,
  message: `Determinism: Math.${property} is implementation-approximated (not bit-exact across JS engines). Keep the core in the correctly-rounded IEEE-754 subset (+ − × ÷ √ min max floor ceil + integer ops). See docs/architecture.md §8.`,
}));

export default tseslint.config(
  {
    // The prototype, the multiplayer test client, and the mobile (Capacitor)
    // wrapper are throwaway demo / build glue; not part of the core or its gate.
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'prototype/**',
      'testclient/**',
      'mobile/**',
      // Semgrep rule fixtures (SEC-2) are intentionally-broken snippets for the
      // `// ruleid:` / `// ok:` unit-test convention, not real source.
      '.semgrep/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Determinism guardrails — enforced only inside the simulation core.
    // See docs/architecture.md §4.2.
    files: ['packages/shared-core/src/**/*.ts'],
    ignores: ['packages/shared-core/src/**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Determinism: use the seeded Rng, never Math.random().',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Determinism: pass time as a parameter (Context.now), never Date.now().',
        },
        ...NON_DETERMINISTIC_MATH,
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'Determinism: time must be a parameter in shared-core; avoid Date here.',
        },
      ],
    },
  },
  {
    // CI / repo-automation scripts run on Node — give them the Node globals they use
    // (the determinism rules above never apply here; this is build glue, not the core).
    files: ['.github/**/*.{mjs,js}', 'scripts/**/*.{mjs,js}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);
