import { defineConfig } from 'vite';

// `base: './'` makes the build work from any sub-path, e.g. https://<user>.github.io/<repo>/
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
