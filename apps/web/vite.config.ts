import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { injectApiOriginIntoHeaders, validateProductionApiBaseUrl } from './src/lib/csp.js';

function pagesHeadersCspPlugin(apiBaseUrl: string): Plugin {
  return {
    name: 'content-desk-pages-headers-csp',
    apply: 'build',
    closeBundle() {
      const distHeadersPath = path.resolve(import.meta.dirname, 'dist', '_headers');
      if (!fs.existsSync(distHeadersPath)) return;
      const original = fs.readFileSync(distHeadersPath, 'utf8');
      const updated = injectApiOriginIntoHeaders(original, apiBaseUrl);
      fs.writeFileSync(distHeadersPath, updated, 'utf8');
    }
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_');
  const apiBaseUrl = env.VITE_API_BASE_URL ?? process.env.VITE_API_BASE_URL ?? '';

  if (command === 'build') {
    const guard = validateProductionApiBaseUrl(apiBaseUrl, {
      cfPages: process.env.CF_PAGES,
      requireApiBaseUrl: process.env.REQUIRE_API_BASE_URL
    });
    if (guard.warning) {
      console.warn(guard.warning);
    }
  }

  return {
    plugins: [react(), tailwindcss(), pagesHeadersCspPlugin(apiBaseUrl)],
    build: {
      target: ['es2022', 'safari16.4', 'chrome111', 'firefox128']
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true
        }
      }
    }
  };
});
