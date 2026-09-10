import { defineConfig } from 'vite';

export default defineConfig({
  // Electron loads the production UI with file://, so bundled assets must be
  // relative to dist/index.html rather than rooted at /assets.
  base: './'
});
