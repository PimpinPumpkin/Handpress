import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built site works from any path, including Pages subpaths.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  worker: { format: 'es' },
});
