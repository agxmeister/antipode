import type { Migration } from './index.ts';

/**
 * The resolved Role Config `retries` of a Stage attempt (AD-4, AD-15), stored when it launches so
 * the synchronous retry rule reads it; null until then and for the `test` step.
 */
export const migration0007: Migration = {
  id: 7,
  name: 'stage-retries',
  sql: `
    ALTER TABLE stages ADD COLUMN retries INTEGER;
  `,
};
