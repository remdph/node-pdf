import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '~renderer': path.resolve(__dirname, 'src/renderer'),
      '~shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    // Forge's plugin-vite expects the renderer bundle at
    // <project>/.vite/renderer/<name>/. Because `root` is set to src/renderer,
    // Vite would otherwise resolve `outDir` relative to that root and write to
    // src/renderer/.vite/..., so the packaged app would load a missing
    // index.html and show a blank window. Pin it to an absolute path.
    outDir: path.resolve(__dirname, '.vite/renderer/main_window'),
    emptyOutDir: true,
  },
});
