import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '~main': path.resolve(__dirname, 'src/main'),
      '~shared': path.resolve(__dirname, 'src/shared'),
    },
    // Prefer Node-resolved modules in the main process (omit 'browser').
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      external: ['electron'],
      output: {
        entryFileNames: 'main.js',
      },
    },
  },
});
