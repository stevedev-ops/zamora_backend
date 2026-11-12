import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    preserveSymlinks: process.platform === 'win32',
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['src/tests/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
