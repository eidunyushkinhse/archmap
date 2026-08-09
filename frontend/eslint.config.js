import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'coverage']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strict,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Параметры колбэков, чьи сигнатуры диктуют пропсы детей (напр. `_id`/`_saved`
      // в TreePage), помечаются подчёркиванием — оно уже документирует «намеренно не
      // используется». Не заставляем удалять параметр из сигнатуры ради линта.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    // nodes/edges/shapes экспортируют реестры nodeTypes/edgeTypes и хелперы рядом с
    // компонентами — так устроен React Flow (типы узлов/рёбер регистрируются картой).
    // Ценность правила — гранулярность HMR — для внутренностей канвы нулевая: любая
    // правка пересобирает граф целиком. Отключаем точечно для graph/**.
    files: ['src/components/graph/**'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    // Тесты легитимно используют `!` после ассертов (expect(x).toBeDefined(); x!.foo)
    // и для доступа по индексу сразу после проверки длины — это общепринятая конвенция,
    // гарды лишь зашумляют тестовый код. Продакшн-код от этого правила не освобождается.
    files: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
])
