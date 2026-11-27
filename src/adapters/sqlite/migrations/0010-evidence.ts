import type { Migration } from './index.ts';

/**
 * Evidence (AD-2, AD-8, AD-16): one immutable row per ingested artifact of a Review round, its file
 * under `data/evidence/` named by `path`. Only `superseded` changes, and only from 0 to 1; the triggers
 * refuse any other update and every delete.
 */
export const migration0010: Migration = {
  id: 10,
  name: 'evidence',
  sql: `
    CREATE TABLE evidence (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES tasks(id),
      round        INTEGER NOT NULL CHECK (round > 0),
      criterion_id TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK (kind IN ('screenshot', 'screencast', 'render', 'composite', 'test_result', 'measurement', 'file')),
      path         TEXT NOT NULL UNIQUE,
      bytes        INTEGER NOT NULL CHECK (bytes >= 0),
      degraded     TEXT,
      before_of    TEXT,
      caption      TEXT NOT NULL,
      stage_id     TEXT REFERENCES stages(id),
      superseded   INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
      created_at   TEXT NOT NULL
    ) STRICT;
    CREATE INDEX evidence_task_round ON evidence(task_id, round);

    CREATE TRIGGER evidence_never_deleted BEFORE DELETE ON evidence
    BEGIN
      SELECT RAISE(ABORT, 'evidence rows are never deleted');
    END;

    CREATE TRIGGER evidence_immutable BEFORE UPDATE ON evidence
    WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.round IS NOT OLD.round
      OR NEW.criterion_id IS NOT OLD.criterion_id OR NEW.kind IS NOT OLD.kind OR NEW.path IS NOT OLD.path
      OR NEW.bytes IS NOT OLD.bytes OR NEW.degraded IS NOT OLD.degraded OR NEW.before_of IS NOT OLD.before_of
      OR NEW.caption IS NOT OLD.caption OR NEW.stage_id IS NOT OLD.stage_id OR NEW.created_at IS NOT OLD.created_at
      OR NEW.superseded < OLD.superseded
    BEGIN
      SELECT RAISE(ABORT, 'evidence rows are immutable but for superseded');
    END;
  `,
};
