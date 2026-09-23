import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // In-app links must keep the namespace in the URL: route them through
    // useNamespacedNavigate and NamespacedLink. NamespaceContext is the one place that sets
    // the namespace itself, so it keeps the raw router API.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/hooks/useNamespacedNavigate.ts', 'src/components/ui/NamespacedLink.tsx', 'src/context/NamespaceContext.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-router-dom',
              importNames: ['useNavigate', 'Link'],
              message: 'Use useNamespacedNavigate or NamespacedLink so in-app links keep the namespace.',
            },
          ],
        },
      ],
    },
  },
]);
