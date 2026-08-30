import { defineConfig } from 'vitest/config';

// Provider-contract tests do not touch PostgreSQL, so they can run in constrained environments
// without the destructive database recreation performed by the integration suite's global setup.
export default defineConfig({
  test: {
    include: ['test/admin-auth-provider.test.ts', 'test/storage.test.ts'],
    testTimeout: 10_000,
  },
});
