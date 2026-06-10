import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure-logic unit tests live in test/; they must not hit the network,
    // a browser, or a real database.
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
});
