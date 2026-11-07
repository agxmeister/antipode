import type { Migration } from './index.ts';

export const migration0001: Migration = {
  id: 1,
  name: 'settings',
  sql: `
    CREATE TABLE settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `,
};
