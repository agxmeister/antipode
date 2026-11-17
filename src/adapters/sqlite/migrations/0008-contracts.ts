import type { Migration } from './index.ts';

/**
 * Contracts and drafts (AD-2, AD-5, AD-9, AD-21): versioned `contracts` rows with their `criteria`
 * (the record once a Task exists), the questions of a draft, the inbox files already imported keyed
 * by `(path, blob_sha)`, the Owner and bot messages Intake reads, and a Task's title and Branch slug.
 * `contracts` keeps one row per version; `criteria` holds the current criteria, a dropped one kept
 * with `status = dropped` so its `AC<n>` is never reused (AD-16).
 */
export const migration0008: Migration = {
  id: 8,
  name: 'contracts',
  sql: `
    ALTER TABLE tasks ADD COLUMN title TEXT;
    ALTER TABLE tasks ADD COLUMN slug TEXT;

    CREATE TABLE contracts (
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      version    INTEGER NOT NULL CHECK (version > 0),
      goal       TEXT NOT NULL,
      depends_on TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, version)
    ) STRICT;

    CREATE TABLE criteria (
      task_id             TEXT NOT NULL REFERENCES tasks(id),
      ac_no               INTEGER NOT NULL CHECK (ac_no > 0),
      text                TEXT NOT NULL,
      required_evidence   TEXT NOT NULL,
      infeasible_wanted   TEXT,
      infeasible_proposal TEXT,
      status              TEXT NOT NULL CHECK (status IN ('active', 'dropped')),
      PRIMARY KEY (task_id, ac_no)
    ) STRICT;

    CREATE TABLE draft_questions (
      task_id       TEXT NOT NULL REFERENCES tasks(id),
      q_no          INTEGER NOT NULL CHECK (q_no > 0),
      text          TEXT NOT NULL,
      quick_answers TEXT NOT NULL DEFAULT '[]',
      answer        TEXT,
      PRIMARY KEY (task_id, q_no)
    ) STRICT;

    CREATE TABLE contract_sources (
      project_id TEXT NOT NULL REFERENCES projects(id),
      path       TEXT NOT NULL,
      blob_sha   TEXT NOT NULL,
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, path, blob_sha)
    ) STRICT;
    CREATE INDEX contract_sources_task ON contract_sources(task_id);

    CREATE TABLE intake_messages (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      sender     TEXT NOT NULL CHECK (sender IN ('owner', 'bot', 'inbox')),
      text       TEXT NOT NULL,
      message_id INTEGER,
      at         TEXT NOT NULL
    ) STRICT;
    CREATE INDEX intake_messages_task ON intake_messages(task_id);
  `,
};
