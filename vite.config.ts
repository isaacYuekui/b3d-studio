/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `--mode single` inlines everything into one HTML file (used for preview publishing).
export default defineConfig(({ mode }) => ({
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 4000,
    target: 'es2020',
  },
  // quickhull3d ships extension-less ESM imports: let Vite resolve them in tests too.
  test: { environment: 'node', include: ['tests/**/*.test.ts'], server: { deps: { inline: ['quickhull3d'] } } },
}));
