import { defineConfig, type Plugin } from 'vite';

// GitHub Pages cannot send response headers, so the Content-Security-Policy ships as a <meta>
// tag. It is added to production builds only: the dev server injects inline scripts for HMR.
// Inline styles stay allowed because the UI sets style attributes from code.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.cartocdn.com https://gibs.earthdata.nasa.gov",
  "connect-src 'self' data: blob: https://*.cartocdn.com https://gibs.earthdata.nasa.gov",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'atlas-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  };
}

// `base: './'` makes the build work from any sub-path, e.g. https://<user>.github.io/<repo>/
export default defineConfig({
  base: './',
  plugins: [contentSecurityPolicy()],
  // MapLibre starts its worker as a module, so the worker bundle has to be one too.
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
