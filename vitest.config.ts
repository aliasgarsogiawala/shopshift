import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Never let a developer's real Shopify or ShopShift context leak into a test run.
    unstubEnvs: true,
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/bin.ts'] },
  },
});
