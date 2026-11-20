import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { WorkerBindings } from '../src/env.js';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerBindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
