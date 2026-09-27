import { defineConfig } from 'vite';

// Разработка: страница с Vite (5274), API и файлы — у сервера 3DModelist (8770).
// Сборка: dist/ отдаёт сам сервер, Vite не нужен.
export default defineConfig({
  base: './',
  server: {
    port: 5274,
    proxy: {
      '/api': 'http://127.0.0.1:8770',
      '/files': 'http://127.0.0.1:8770',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
