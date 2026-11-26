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
            ADMIN_UIDS: 'owner-uid-1',
            ALLOWED_ORIGINS: 'http://localhost:5173',
            R2_ACCOUNT_ID: 'test-r2-account-id',
            R2_BUCKET_NAME: 'content-desk-bucket',
            R2_ACCESS_KEY_ID: 'test-r2-access-key-id',
            R2_SECRET_ACCESS_KEY: 'test-r2-secret-access-key',
            GEMINI_API_KEY: 'test-gemini-api-key',
            NAVER_CLIENT_ID: 'test-naver-client-id',
            NAVER_CLIENT_SECRET: 'test-naver-client-secret',
            SESSION_MAX_AGE_SECONDS: '1209600',
            REAUTH_MAX_AGE_SECONDS: '900',
            CLOCK_SKEW_SECONDS: '60'
          }
        }
      })
    ]
  };
});
