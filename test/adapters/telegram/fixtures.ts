import { ulid } from '../../../src/core/domain/ids.ts';
import type { Project, Task } from '../../../src/core/domain/task.ts';
import type { SqliteStore } from '../../../src/adapters/sqlite/store.ts';

export const NOW = '2026-11-08T12:00:00.000Z';

/** Inserts a Project, bound to `chatId` unless it is null. */
export function insertProject(store: SqliteStore, chatId: number | null, name = `p-${ulid()}`): Project {
  const project: Project = { id: ulid(), name, paused_at: null, telegram_chat_id: chatId, repo_url: null, exclusive_capabilities: [], created_at: NOW };
  store.insertProject(project);
  return project;
}

export function insertTask(store: SqliteStore, projectId: string, overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: ulid(),
    project_id: projectId,
    kind: 'feature',
    task_no: 3,
    state: 'in_review',
    current_stage_id: null,
    budget_used: 1,
    budget_limit: 5,
    review_round: 1,
    resume_state: null,
    stuck_reason: null,
    waiting_reason: null,
    undo_expires_at: null,
    config_sha: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  store.insertTask(task);
  return task;
}
