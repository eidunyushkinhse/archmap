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
      // Coverage-ratchet (замер 2026-10-14: 74.57/69.69/65.87/76.53; прежний — 2026-08-01,
      // 45/37/32/45). Пороги чуть ниже фактических — CI (vitest run --coverage) гарантирует,
      // что покрытие не откатится назад. Выросло — подними пороги.
      thresholds: {
        statements: 73,
        branches: 68,
        functions: 64,
        lines: 75,
      },
    },
  },
})
