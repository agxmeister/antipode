import type { Migration } from './index.ts';

/**
 * The implement, validate and triage loop (AD-2, AD-16, AD-21): each Stage attempt's typed output on
 * its `stages` row (JSON), so briefs are rendered from rows, and the Parking Lot, one `P<p_no>` per
 * Task for each non-blocking finding Triage parked.
 */
export const migration0009: Migration = {
  id: 9,
  name: 'loop',
  sql: `
    ALTER TABLE stages ADD COLUMN output TEXT;

    CREATE TABLE parking_lot (
      id              TEXT PRIMARY KEY,
      task_id         TEXT NOT NULL REFERENCES tasks(id),
      p_no            INTEGER NOT NULL CHECK (p_no > 0),
      criterion_id    TEXT NOT NULL,
      note            TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('open', 'promoted', 'dismissed')),
      source_stage_id TEXT REFERENCES stages(id),
      created_at      TEXT NOT NULL,
      UNIQUE (task_id, p_no)
    ) STRICT;
  `,
};
