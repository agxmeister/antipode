import type { Migration } from './index.ts';

/**
 * Telegram surface (AD-10): the chat a Project is bound to, the per-chat `outbox` every send and edit
 * goes through, the `callbacks` behind inline buttons, and `telegram_messages` for reply targeting.
 * SQLite cannot add a UNIQUE column, so the chat binding's uniqueness is a unique index (NULLs allowed).
 */
export const migration0004: Migration = {
  id: 4,
  name: 'telegram',
  sql: `
    ALTER TABLE projects ADD COLUMN telegram_chat_id INTEGER;
    CREATE UNIQUE INDEX projects_telegram_chat_id ON projects(telegram_chat_id);

    CREATE TABLE outbox (
      id                TEXT PRIMARY KEY,
      chat_id           INTEGER NOT NULL,
      sequence          INTEGER NOT NULL,
      kind              TEXT NOT NULL,
      payload           TEXT NOT NULL,
      task_id           TEXT REFERENCES tasks(id),
      round             INTEGER,
      target_message_id INTEGER,
      target_outbox_id  TEXT REFERENCES outbox(id),
      sent_message_id   INTEGER,
      attempts          INTEGER NOT NULL DEFAULT 0,
      next_attempt_at   TEXT,
      status            TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
      error             TEXT,
      effect_id         TEXT,
      created_at        TEXT NOT NULL,
      sent_at           TEXT,
      UNIQUE (chat_id, sequence),
      UNIQUE (effect_id, kind, sequence)
    ) STRICT;
    CREATE INDEX outbox_status_chat ON outbox(status, chat_id, sequence);
    CREATE INDEX outbox_task ON outbox(task_id);
    CREATE INDEX outbox_effect ON outbox(effect_id);

    CREATE TABLE callbacks (
      id         TEXT PRIMARY KEY,
      command    TEXT NOT NULL,
      task_id    TEXT REFERENCES tasks(id),
      round      INTEGER,
      args       TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE telegram_messages (
      chat_id    INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      task_id    TEXT REFERENCES tasks(id),
      round      INTEGER,
      kind       TEXT NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    ) STRICT;
    CREATE INDEX telegram_messages_task ON telegram_messages(task_id);
  `,
};
