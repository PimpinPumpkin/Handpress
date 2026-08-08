import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  // The version comes from package.json so the number on screen and the number
  // in the repository cannot disagree.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Relative base so the built site works from any path, including Pages subpaths.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  worker: { format: 'es' },
});
