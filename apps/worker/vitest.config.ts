import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrationsPath = path.join(import.meta.dirname, 'migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            FIREBASE_PROJECT_ID: 'content-desk-b9c3d',
            ALLOWED_UIDS: 'owner-uid-1',
            ALLOWED_ORIGINS: 'http://localhost:5173',
            SESSION_MAX_AGE_SECONDS: '1209600',
            REAUTH_MAX_AGE_SECONDS: '900',
            CLOCK_SKEW_SECONDS: '60'
          }
        }
      })
    ]
  };
});
