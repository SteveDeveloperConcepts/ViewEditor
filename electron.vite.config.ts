import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const shared = resolve(__dirname, 'src/shared');

// The packaged page may only load its own files and library media. The dev server needs
// inline scripts for hot reload, so the policy is added to production builds only.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: media:",
  "media-src 'self' blob: media:",
  "font-src 'self' data: media:",
  "connect-src 'self' media:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'vieweditor-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        return html.replace('<!--csp-->', ctx.server ? '' : `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
      },
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    // The preload runs sandboxed, so it has to be one self-contained file.
    build: { externalizeDeps: false },
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': shared,
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react(), contentSecurityPolicy()],
  },
});
