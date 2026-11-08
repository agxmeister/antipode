import type { Migration } from './index.ts';

/** Coordinator core (AD-2, AD-3): Projects, Tasks, Stages, the append-only event log and the effects queue. */
export const migration0002: Migration = {
  id: 2,
  name: 'coordinator',
  sql: `
    CREATE TABLE projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      paused_at  TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE tasks (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL REFERENCES projects(id),
      kind             TEXT NOT NULL CHECK (kind IN ('feature', 'bootstrap')),
      task_no          INTEGER,
      state            TEXT NOT NULL,
      current_stage_id TEXT,
      budget_used      INTEGER NOT NULL DEFAULT 0,
      budget_limit     INTEGER NOT NULL,
      review_round     INTEGER NOT NULL DEFAULT 0,
      resume_state     TEXT,
      stuck_reason     TEXT,
      waiting_reason   TEXT,
      undo_expires_at  TEXT,
      config_sha       TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      UNIQUE (project_id, task_no)
    ) STRICT;
    CREATE INDEX tasks_state ON tasks(state);
    CREATE INDEX tasks_project ON tasks(project_id);

    CREATE TABLE stages (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      role       TEXT NOT NULL,
      attempt    INTEGER NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('starting', 'running', 'succeeded', 'failed', 'cancelled')),
      reason     TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at   TEXT
    ) STRICT;
    CREATE INDEX stages_task ON stages(task_id);
    CREATE INDEX stages_status ON stages(status);

    CREATE TABLE stage_events (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL REFERENCES tasks(id),
      stage_id      TEXT,
      event_type    TEXT NOT NULL,
      payload       TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('applied', 'ignored')),
      ignore_reason TEXT CHECK (ignore_reason IN ('invalid', 'stale')),
      from_state    TEXT,
      to_state      TEXT,
      created_at    TEXT NOT NULL
    ) STRICT;
    CREATE INDEX stage_events_task ON stage_events(task_id);

    CREATE TABLE effects (
      effect_id   TEXT PRIMARY KEY,
      task_id     TEXT REFERENCES tasks(id),
      kind        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
      error       TEXT,
      created_at  TEXT NOT NULL,
      finished_at TEXT
    ) STRICT;
    CREATE INDEX effects_status ON effects(status);
    CREATE INDEX effects_task ON effects(task_id);
  `,
};
