import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The studio reuses the original BuddyRevival code and data in place:
//   @original  -> ../web/src     (decoder, catalog, wardrobe, texture composer; imported, never copied)
//   publicDir  -> ../web/assets  (chick.bin, catalog.xml, symbols.json, ... served as-is)
const original = fileURLToPath(new URL('../web/src', import.meta.url));
const assets = fileURLToPath(new URL('../web/assets', import.meta.url));

export default defineConfig({
  base: './',
  plugins: [react()],
  publicDir: assets,
  resolve: { alias: { '@original': original } },
  server: { port: 5417, fs: { allow: ['..'] } },
  preview: { port: 4417 },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
