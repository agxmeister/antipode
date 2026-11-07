import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Every test run gets a scratch instance; the Owner's ~/.antipod is never touched (AD-24).
const scratchHome = mkdtempSync(join(tmpdir(), 'antipod-vitest-'));

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**', 'node_modules/**', 'dist/**'],
    setupFiles: ['test/setup.ts'],
    env: { ANTIPOD_HOME: scratchHome },
    testTimeout: 20_000,
  },
});
