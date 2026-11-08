import type { Statement } from 'better-sqlite3';
import { effectSchema, effectStatusSchema, type EffectRow, type EffectStatus } from '../../core/domain/effects.ts';
import { stageEventRowSchema, type StageEventRow } from '../../core/domain/events.ts';
import { stageSchema, type Stage, type StagePatch, type StageStatus } from '../../core/domain/stage.ts';
import { ACTIVE_STATES, projectSchema, taskSchema, type Project, type Task, type TaskPatch, type TaskState } from '../../core/domain/task.ts';
import type { Store } from '../../core/ports/store.ts';
import type { SqliteDatabase } from './db.ts';

const TASK_COLUMNS = [
  'id',
  'project_id',
  'kind',
  'task_no',
  'state',
  'current_stage_id',
  'budget_used',
  'budget_limit',
  'review_round',
  'resume_state',
  'stuck_reason',
  'waiting_reason',
  'undo_expires_at',
  'config_sha',
  'created_at',
  'updated_at',
] as const;

const TASK_PATCHABLE: ReadonlySet<string> = new Set(TASK_COLUMNS.filter((c) => !['id', 'project_id', 'kind', 'created_at'].includes(c)));
const STAGE_PATCHABLE: ReadonlySet<string> = new Set(['status', 'reason', 'started_at', 'ended_at']);

const STAGE_COLUMNS = ['id', 'task_id', 'role', 'attempt', 'status', 'reason', 'created_at', 'started_at', 'ended_at'] as const;
const EVENT_COLUMNS = ['id', 'task_id', 'stage_id', 'event_type', 'payload', 'status', 'ignore_reason', 'from_state', 'to_state', 'created_at'] as const;

function insertSql(table: string, columns: readonly string[]): string {
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

interface EffectDbRow {
  effect_id: string;
  task_id: string | null;
  kind: string;
  payload: string;
  status: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

function toEffectRow(row: EffectDbRow): EffectRow {
  const effect = effectSchema.parse(JSON.parse(row.payload));
  return {
    effect_id: row.effect_id,
    task_id: row.task_id,
    kind: effect.kind,
    effect,
    status: effectStatusSchema.parse(row.status),
    error: row.error,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

/** `Store` over better-sqlite3 with prepared statements (AD-2). Rows are validated on the way out. */
export class SqliteStore implements Store {
  readonly #db: SqliteDatabase;
  readonly #stmt: {
    insertProject: Statement;
    getProject: Statement;
    listProjects: Statement;
    activeProjects: Statement;
    insertTask: Statement;
    getTask: Statement;
    nextTaskNo: Statement;
    insertStage: Statement;
    getStage: Statement;
    stagesOfTask: Statement;
    appendStageEvent: Statement;
    stageEventsOfTask: Statement;
    insertEffect: Statement;
    getEffect: Statement;
    pendingEffects: Statement;
    effectsOfTask: Statement;
    markEffect: Statement;
  };

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#stmt = {
      insertProject: db.prepare(insertSql('projects', ['id', 'name', 'paused_at', 'created_at'])),
      getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
      listProjects: db.prepare('SELECT * FROM projects ORDER BY created_at, id'),
      activeProjects: db.prepare(
        `SELECT DISTINCT p.* FROM projects p JOIN tasks t ON t.project_id = p.id
         WHERE t.state IN (${placeholders(ACTIVE_STATES.length)}) ORDER BY p.created_at, p.id`,
      ),
      insertTask: db.prepare(insertSql('tasks', TASK_COLUMNS)),
      getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
      nextTaskNo: db.prepare('SELECT COALESCE(MAX(task_no), 0) + 1 AS next FROM tasks WHERE project_id = ?'),
      insertStage: db.prepare(insertSql('stages', STAGE_COLUMNS)),
      getStage: db.prepare('SELECT * FROM stages WHERE id = ?'),
      stagesOfTask: db.prepare('SELECT * FROM stages WHERE task_id = ? ORDER BY id'),
      appendStageEvent: db.prepare(insertSql('stage_events', EVENT_COLUMNS)),
      stageEventsOfTask: db.prepare('SELECT * FROM stage_events WHERE task_id = ? ORDER BY id'),
      insertEffect: db.prepare(insertSql('effects', ['effect_id', 'task_id', 'kind', 'payload', 'status', 'error', 'created_at', 'finished_at'])),
      getEffect: db.prepare('SELECT * FROM effects WHERE effect_id = ?'),
      // effect_id is a monotonic ULID, so id order is insertion order (AD-3).
      pendingEffects: db.prepare("SELECT * FROM effects WHERE status = 'pending' ORDER BY effect_id"),
      effectsOfTask: db.prepare('SELECT * FROM effects WHERE task_id = ? ORDER BY effect_id'),
      markEffect: db.prepare('UPDATE effects SET status = @status, error = @error, finished_at = @finished_at WHERE effect_id = @effect_id'),
    };
  }

  transaction<T>(fn: () => T): T {
    if (this.#db.inTransaction) {
      return fn();
    }
    return this.#db.transaction(fn).immediate();
  }

  insertProject(project: Project): void {
    this.#stmt.insertProject.run(project);
  }

  getProject(id: string): Project | undefined {
    const row = this.#stmt.getProject.get(id);
    return row === undefined ? undefined : projectSchema.parse(row);
  }

  listProjects(): Project[] {
    return this.#stmt.listProjects.all().map((row) => projectSchema.parse(row));
  }

  activeProjects(): Project[] {
    return this.#stmt.activeProjects.all(...ACTIVE_STATES).map((row) => projectSchema.parse(row));
  }

  insertTask(task: Task): void {
    this.#stmt.insertTask.run(task);
  }

  getTask(id: string): Task | undefined {
    const row = this.#stmt.getTask.get(id);
    return row === undefined ? undefined : taskSchema.parse(row);
  }

  updateTask(id: string, patch: TaskPatch & { state?: TaskState; updated_at: string }): void {
    this.#update('tasks', 'id', id, patch, TASK_PATCHABLE);
  }

  tasksInStates(states: readonly TaskState[]): Task[] {
    if (states.length === 0) {
      return [];
    }
    return this.#db
      .prepare(`SELECT * FROM tasks WHERE state IN (${placeholders(states.length)}) ORDER BY created_at, id`)
      .all(...states)
      .map((row) => taskSchema.parse(row));
  }

  nextTaskNo(projectId: string): number {
    return (this.#stmt.nextTaskNo.get(projectId) as { next: number }).next;
  }

  insertStage(stage: Stage): void {
    this.#stmt.insertStage.run(stage);
  }

  getStage(id: string): Stage | undefined {
    const row = this.#stmt.getStage.get(id);
    return row === undefined ? undefined : stageSchema.parse(row);
  }

  updateStage(id: string, patch: StagePatch): void {
    this.#update('stages', 'id', id, patch, STAGE_PATCHABLE);
  }

  stagesInStatus(statuses: readonly StageStatus[]): Stage[] {
    if (statuses.length === 0) {
      return [];
    }
    return this.#db
      .prepare(`SELECT * FROM stages WHERE status IN (${placeholders(statuses.length)}) ORDER BY id`)
      .all(...statuses)
      .map((row) => stageSchema.parse(row));
  }

  stagesOfTask(taskId: string): Stage[] {
    return this.#stmt.stagesOfTask.all(taskId).map((row) => stageSchema.parse(row));
  }

  appendStageEvent(row: StageEventRow): void {
    this.#stmt.appendStageEvent.run(row);
  }

  stageEventsOfTask(taskId: string): StageEventRow[] {
    return this.#stmt.stageEventsOfTask.all(taskId).map((row) => stageEventRowSchema.parse(row));
  }

  insertEffect(row: EffectRow): void {
    this.#stmt.insertEffect.run({
      effect_id: row.effect_id,
      task_id: row.task_id,
      kind: row.kind,
      payload: JSON.stringify(row.effect),
      status: row.status,
      error: row.error,
      created_at: row.created_at,
      finished_at: row.finished_at,
    });
  }

  getEffect(effectId: string): EffectRow | undefined {
    const row = this.#stmt.getEffect.get(effectId) as EffectDbRow | undefined;
    return row === undefined ? undefined : toEffectRow(row);
  }

  pendingEffects(): EffectRow[] {
    return (this.#stmt.pendingEffects.all() as EffectDbRow[]).map(toEffectRow);
  }

  effectsOfTask(taskId: string): EffectRow[] {
    return (this.#stmt.effectsOfTask.all(taskId) as EffectDbRow[]).map(toEffectRow);
  }

  markEffect(effectId: string, status: EffectStatus, finishedAt: string, error?: string): void {
    this.#stmt.markEffect.run({ effect_id: effectId, status, error: error ?? null, finished_at: finishedAt });
  }

  #update(table: string, key: string, id: string, patch: Record<string, unknown>, allowed: ReadonlySet<string>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return;
    }
    for (const [column] of entries) {
      if (!allowed.has(column)) {
        throw new Error(`column ${table}.${column} is not patchable`);
      }
    }
    const sets = entries.map(([column]) => `${column} = @${column}`).join(', ');
    const params = Object.fromEntries(entries);
    const result = this.#db.prepare(`UPDATE ${table} SET ${sets} WHERE ${key} = @__id`).run({ ...params, __id: id });
    if (result.changes !== 1) {
      throw new Error(`${table} row ${id} not found`);
    }
  }
}
