import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Сборка живой схемы для лендинга (src/embed, страница embed.html): холст приложения
// на статическом снимке демо-проекта, без бэкенда. Пути относительные — папку
// dist-embed кладут рядом с лендингом и встраивают страницу через iframe.
// Воркер конвейера — ES-модуль: так elk остаётся ленивым чанком и внутри воркера
// (формат iife склеил бы его в файл воркера, и полтора мегабайта грузились бы сразу).
export default defineConfig({
  plugins: [react()],
  base: './',
  // favicon и прочее из public/ странице внутри iframe не нужны
  publicDir: false,
  worker: { format: 'es' },
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    rolldownOptions: { input: 'embed.html' },
  },
})
