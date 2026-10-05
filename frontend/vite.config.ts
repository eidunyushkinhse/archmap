/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Порт бэкенда для прокси /api: ./dev.sh передаёт BACKEND_PORT в окружение, и
// второй экземпляр (BACKEND_PORT=8001 FRONTEND_PORT=5174 ./dev.sh, например демо-стенд
// scripts/dev-demo.sh) проксирует в свой бэк, а не в основной на 8000.
const backendPort = process.env.BACKEND_PORT ?? '8000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
  // Юнит- и компонентные тесты (vitest): чистые функции раскладки/проекции +
  // рендер-тесты страниц/компонентов под jsdom. setup-файл подключает
  // jest-dom-матчеры и моки browser API, недостающих в jsdom.
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/types/api.gen.ts', // генерат из OpenAPI
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/test-setup.ts',
      ],
      // Coverage-ratchet (замер 2026-08-01: 45.49/37.14/32.97/45.75). Пороги чуть
      // ниже фактических — гейт гарантирует, что покрытие не откатится назад.
      thresholds: {
        statements: 45,
        branches: 37,
        functions: 32,
        lines: 45,
      },
    },
  },
})
