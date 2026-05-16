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
});
