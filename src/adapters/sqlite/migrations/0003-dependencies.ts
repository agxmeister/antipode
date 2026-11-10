import type { Migration } from './index.ts';

/** Task dependencies (CAP-15): a Task starts only once every Task it depends on is merged to `main` (AD-11). */
export const migration0003: Migration = {
  id: 3,
  name: 'dependencies',
  sql: `
    CREATE TABLE task_dependencies (
      task_id            TEXT NOT NULL REFERENCES tasks(id),
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
      PRIMARY KEY (task_id, depends_on_task_id),
      CHECK (task_id <> depends_on_task_id)
    ) STRICT;
    CREATE INDEX task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
  `,
};
