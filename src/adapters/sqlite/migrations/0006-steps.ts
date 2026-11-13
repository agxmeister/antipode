import type { Migration } from './index.ts';

/**
 * Step runs and capability leases (AD-2, AD-7), and the exclusive capabilities a Project's Recipe
 * names, read by the scheduler's hint gate (AD-11). A lease's `capability` is its primary key, so
 * at most one step run holds a capability.
 */
export const migration0006: Migration = {
  id: 6,
  name: 'steps',
  sql: `
    CREATE TABLE step_runs (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      stage_id   TEXT REFERENCES stages(id),
      step       TEXT NOT NULL,
      runner     TEXT NOT NULL CHECK (runner IN ('container', 'host')),
      status     TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed')),
      outcome    TEXT CHECK (outcome IN ('exited', 'timeout', 'capability_busy')),
      exit_code  INTEGER,
      reason     TEXT,
      started_at TEXT NOT NULL,
      ended_at   TEXT
    ) STRICT;
    CREATE INDEX step_runs_status ON step_runs(status);
    CREATE INDEX step_runs_task ON step_runs(task_id);

    CREATE TABLE capability_leases (
      capability  TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      step_run_id TEXT NOT NULL REFERENCES step_runs(id),
      acquired_at TEXT NOT NULL
    ) STRICT;

    ALTER TABLE projects ADD COLUMN exclusive_capabilities TEXT NOT NULL DEFAULT '[]';
  `,
};
