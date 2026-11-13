import type { Statement } from 'better-sqlite3';
import { effectSchema, effectStatusSchema, type EffectRow, type EffectStatus } from '../../core/domain/effects.ts';
import { stageEventRowSchema, type StageEventRow } from '../../core/domain/events.ts';
import { stageSchema, type Stage, type StagePatch, type StageStatus } from '../../core/domain/stage.ts';
import {
  capabilityLeaseSchema,
  stepRunSchema,
  type CapabilityLease,
  type StepRun,
  type StepRunEnd,
  type StepRunStatus,
} from '../../core/domain/step.ts';
import { ACTIVE_STATES, projectSchema, taskSchema, type Project, type Task, type TaskPatch, type TaskState } from '../../core/domain/task.ts';
import { ulid } from '../../core/domain/ids.ts';
import {
  callbackRowSchema,
  outboxRowSchema,
  telegramMessageRowSchema,
  type CallbackRow,
  type OutboxDraft,
  type OutboxRow,
  type TelegramMessageRow,
} from '../../core/domain/telegram.ts';
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

const OUTBOX_COLUMNS = [
  'id',
  'chat_id',
  'sequence',
  'kind',
  'payload',
  'task_id',
  'round',
  'target_message_id',
  'target_outbox_id',
  'sent_message_id',
  'attempts',
  'next_attempt_at',
  'status',
  'error',
  'effect_id',
  'created_at',
  'sent_at',
] as const;

const STEP_RUN_COLUMNS = ['id', 'task_id', 'stage_id', 'step', 'runner', 'status', 'outcome', 'exit_code', 'reason', 'started_at', 'ended_at'] as const;

/** `projects.exclusive_capabilities` is a JSON array in a TEXT column. */
function toProject(row: unknown): Project {
  const raw = row as Record<string, unknown>;
  return projectSchema.parse({ ...raw, exclusive_capabilities: JSON.parse(String(raw['exclusive_capabilities'] ?? '[]')) });
}

function toOutboxRow(row: unknown): OutboxRow {
  const raw = row as Record<string, unknown>;
  return outboxRowSchema.parse({ ...raw, payload: JSON.parse(String(raw['payload'])) });
}

function toCallbackRow(row: unknown): CallbackRow {
  const raw = row as Record<string, unknown>;
  return callbackRowSchema.parse({ ...raw, args: JSON.parse(String(raw['args'])) });
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
    projectByRepo: Statement;
    projectByName: Statement;
    activeProjects: Statement;
    insertTask: Statement;
    getTask: Statement;
    nextTaskNo: Statement;
    queuedTasks: Statement;
    bootstrapReleased: Statement;
    insertDependency: Statement;
    dependenciesOf: Statement;
    latestNotify: Statement;
    latestNotifyAnyKey: Statement;
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
    getSetting: Statement;
    setSetting: Statement;
    bindProjectChat: Statement;
    projectByChat: Statement;
    outboxOfEffect: Statement;
    maxSequence: Statement;
    insertOutbox: Statement;
    getOutbox: Statement;
    outboxHeads: Statement;
    outboxOfChat: Statement;
    latestCardOutbox: Statement;
    latestCardOutboxOfRound: Statement;
    markOutboxSent: Statement;
    markOutboxAttempt: Statement;
    markOutboxFailed: Statement;
    insertCallback: Statement;
    getCallback: Statement;
    insertTelegramMessage: Statement;
    getTelegramMessage: Statement;
    latestCardOfTask: Statement;
    setExclusiveCapabilities: Statement;
    insertStepRun: Statement;
    getStepRun: Statement;
    finishStepRun: Statement;
    acquireLease: Statement;
    releaseLease: Statement;
    listLeases: Statement;
    clearLeases: Statement;
  };

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#stmt = {
      insertProject: db.prepare(insertSql('projects', ['id', 'name', 'paused_at', 'telegram_chat_id', 'repo_url', 'exclusive_capabilities', 'created_at'])),
      getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
      listProjects: db.prepare('SELECT * FROM projects ORDER BY created_at, id'),
      projectByRepo: db.prepare('SELECT * FROM projects WHERE repo_url = ?'),
      projectByName: db.prepare('SELECT * FROM projects WHERE name = ?'),
      activeProjects: db.prepare(
        `SELECT DISTINCT p.* FROM projects p JOIN tasks t ON t.project_id = p.id
         WHERE t.state IN (${placeholders(ACTIVE_STATES.length)}) ORDER BY p.created_at, p.id`,
      ),
      insertTask: db.prepare(insertSql('tasks', TASK_COLUMNS)),
      getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
      nextTaskNo: db.prepare('SELECT COALESCE(MAX(task_no), 0) + 1 AS next FROM tasks WHERE project_id = ?'),
      queuedTasks: db.prepare("SELECT * FROM tasks WHERE state = 'queued' ORDER BY created_at, id"),
      bootstrapReleased: db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND kind = 'bootstrap' AND state = 'released' LIMIT 1"),
      insertDependency: db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?) ON CONFLICT DO NOTHING'),
      dependenciesOf: db.prepare(
        `SELECT t.* FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
         WHERE d.task_id = ? ORDER BY t.created_at, t.id`,
      ),
      latestNotify: db.prepare(
        `SELECT * FROM effects WHERE task_id = ? AND kind = 'notify'
         AND json_extract(payload, '$.notice_kind') = ? AND json_extract(payload, '$.payload.key') = ?
         ORDER BY effect_id DESC LIMIT 1`,
      ),
      latestNotifyAnyKey: db.prepare(
        `SELECT * FROM effects WHERE task_id = ? AND kind = 'notify' AND json_extract(payload, '$.notice_kind') = ?
         ORDER BY effect_id DESC LIMIT 1`,
      ),
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
      getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @updated_at) ON CONFLICT (key) DO UPDATE SET value = @value, updated_at = @updated_at',
      ),
      bindProjectChat: db.prepare('UPDATE projects SET telegram_chat_id = ? WHERE id = ?'),
      projectByChat: db.prepare('SELECT * FROM projects WHERE telegram_chat_id = ?'),
      outboxOfEffect: db.prepare('SELECT * FROM outbox WHERE effect_id = ? ORDER BY chat_id, sequence'),
      maxSequence: db.prepare('SELECT COALESCE(MAX(sequence), 0) AS max FROM outbox WHERE chat_id = ?'),
      insertOutbox: db.prepare(insertSql('outbox', OUTBOX_COLUMNS)),
      getOutbox: db.prepare('SELECT * FROM outbox WHERE id = ?'),
      outboxHeads: db.prepare(
        `SELECT o.* FROM outbox o
         JOIN (SELECT chat_id, MIN(sequence) AS sequence FROM outbox WHERE status = 'pending' GROUP BY chat_id) h
           ON h.chat_id = o.chat_id AND h.sequence = o.sequence
         ORDER BY o.chat_id`,
      ),
      outboxOfChat: db.prepare('SELECT * FROM outbox WHERE chat_id = ? ORDER BY sequence'),
      latestCardOutbox: db.prepare(
        `SELECT * FROM outbox WHERE task_id = ? AND kind GLOB '*_card' AND json_extract(payload, '$.method') LIKE 'send%'
         ORDER BY created_at DESC, sequence DESC LIMIT 1`,
      ),
      latestCardOutboxOfRound: db.prepare(
        `SELECT * FROM outbox WHERE task_id = ? AND round = ? AND kind GLOB '*_card' AND json_extract(payload, '$.method') LIKE 'send%'
         ORDER BY created_at DESC, sequence DESC LIMIT 1`,
      ),
      markOutboxSent: db.prepare(
        "UPDATE outbox SET status = 'sent', sent_message_id = @sent_message_id, sent_at = @sent_at, error = NULL, attempts = attempts + 1 WHERE id = @id",
      ),
      markOutboxAttempt: db.prepare('UPDATE outbox SET attempts = @attempts, next_attempt_at = @next_attempt_at, error = @error WHERE id = @id'),
      markOutboxFailed: db.prepare("UPDATE outbox SET status = 'failed', attempts = @attempts, error = @error, next_attempt_at = NULL WHERE id = @id"),
      insertCallback: db.prepare(insertSql('callbacks', ['id', 'command', 'task_id', 'round', 'args', 'expires_at', 'created_at'])),
      getCallback: db.prepare('SELECT * FROM callbacks WHERE id = ?'),
      insertTelegramMessage: db.prepare(
        `INSERT INTO telegram_messages (chat_id, message_id, task_id, round, kind) VALUES (@chat_id, @message_id, @task_id, @round, @kind)
         ON CONFLICT (chat_id, message_id) DO UPDATE SET task_id = @task_id, round = @round, kind = @kind`,
      ),
      getTelegramMessage: db.prepare('SELECT * FROM telegram_messages WHERE chat_id = ? AND message_id = ?'),
      latestCardOfTask: db.prepare(
        `SELECT * FROM telegram_messages WHERE task_id = ? AND kind GLOB '*_card' ORDER BY message_id DESC LIMIT 1`,
      ),
      setExclusiveCapabilities: db.prepare('UPDATE projects SET exclusive_capabilities = ? WHERE id = ?'),
      insertStepRun: db.prepare(insertSql('step_runs', STEP_RUN_COLUMNS)),
      getStepRun: db.prepare('SELECT * FROM step_runs WHERE id = ?'),
      finishStepRun: db.prepare(
        'UPDATE step_runs SET status = @status, outcome = @outcome, exit_code = @exit_code, reason = @reason, ended_at = @ended_at WHERE id = @id',
      ),
      acquireLease: db.prepare(
        'INSERT INTO capability_leases (capability, task_id, step_run_id, acquired_at) VALUES (@capability, @task_id, @step_run_id, @acquired_at) ON CONFLICT (capability) DO NOTHING',
      ),
      releaseLease: db.prepare('DELETE FROM capability_leases WHERE step_run_id = ?'),
      listLeases: db.prepare('SELECT * FROM capability_leases ORDER BY acquired_at, capability'),
      clearLeases: db.prepare('DELETE FROM capability_leases'),
    };
  }

  transaction<T>(fn: () => T): T {
    if (this.#db.inTransaction) {
      return fn();
    }
    return this.#db.transaction(fn).immediate();
  }

  insertProject(project: Project): void {
    this.#stmt.insertProject.run({ ...project, exclusive_capabilities: JSON.stringify(project.exclusive_capabilities) });
  }

  getProject(id: string): Project | undefined {
    const row = this.#stmt.getProject.get(id);
    return row === undefined ? undefined : toProject(row);
  }

  listProjects(): Project[] {
    return this.#stmt.listProjects.all().map((row) => toProject(row));
  }

  projectByRepo(repoUrl: string): Project | undefined {
    const row = this.#stmt.projectByRepo.get(repoUrl);
    return row === undefined ? undefined : toProject(row);
  }

  projectByName(name: string): Project | undefined {
    const row = this.#stmt.projectByName.get(name);
    return row === undefined ? undefined : toProject(row);
  }

  activeProjects(): Project[] {
    return this.#stmt.activeProjects.all(...ACTIVE_STATES).map((row) => toProject(row));
  }

  setProjectExclusiveCapabilities(projectId: string, names: readonly string[]): void {
    if (this.#stmt.setExclusiveCapabilities.run(JSON.stringify([...names]), projectId).changes !== 1) {
      throw new Error(`projects row ${projectId} not found`);
    }
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

  countTasksInStates(states: readonly TaskState[]): number {
    if (states.length === 0) {
      return 0;
    }
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state IN (${placeholders(states.length)})`).get(...states) as { n: number };
    return row.n;
  }

  queuedTasks(): Task[] {
    return this.#stmt.queuedTasks.all().map((row) => taskSchema.parse(row));
  }

  bootstrapReleased(projectId: string): boolean {
    return this.#stmt.bootstrapReleased.get(projectId) !== undefined;
  }

  insertDependency(taskId: string, dependsOnTaskId: string): void {
    this.#stmt.insertDependency.run(taskId, dependsOnTaskId);
  }

  dependenciesOf(taskId: string): Task[] {
    return this.#stmt.dependenciesOf.all(taskId).map((row) => taskSchema.parse(row));
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

  latestNotify(taskId: string, noticeKind: string, key?: string): EffectRow | undefined {
    const row = (
      key === undefined ? this.#stmt.latestNotifyAnyKey.get(taskId, noticeKind) : this.#stmt.latestNotify.get(taskId, noticeKind, key)
    ) as EffectDbRow | undefined;
    return row === undefined ? undefined : toEffectRow(row);
  }

  markEffect(effectId: string, status: EffectStatus, finishedAt: string, error?: string): void {
    this.#stmt.markEffect.run({ effect_id: effectId, status, error: error ?? null, finished_at: finishedAt });
  }

  getSetting(key: string): string | undefined {
    return (this.#stmt.getSetting.get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string, updatedAt: string): void {
    this.#stmt.setSetting.run({ key, value, updated_at: updatedAt });
  }

  bindProjectChat(projectId: string, chatId: number | null): void {
    if (this.#stmt.bindProjectChat.run(chatId, projectId).changes !== 1) {
      throw new Error(`projects row ${projectId} not found`);
    }
  }

  projectByChat(chatId: number): Project | undefined {
    const row = this.#stmt.projectByChat.get(chatId);
    return row === undefined ? undefined : toProject(row);
  }

  enqueueOutbox(chatId: number, drafts: readonly OutboxDraft[], effectId: string | null, createdAt: string): OutboxRow[] {
    return this.transaction(() => {
      if (effectId !== null) {
        const existing = this.#stmt.outboxOfEffect.all(effectId).map(toOutboxRow);
        if (existing.length > 0) {
          return existing;
        }
      }
      let sequence = (this.#stmt.maxSequence.get(chatId) as { max: number }).max;
      const rows: OutboxRow[] = [];
      for (const draft of drafts) {
        sequence += 1;
        const row = outboxRowSchema.parse({
          id: draft.id ?? ulid(),
          chat_id: chatId,
          sequence,
          kind: draft.kind,
          payload: draft.payload,
          task_id: draft.task_id ?? null,
          round: draft.round ?? null,
          target_message_id: draft.target_message_id ?? null,
          target_outbox_id: draft.target_outbox_id ?? null,
          sent_message_id: null,
          attempts: 0,
          next_attempt_at: null,
          status: 'pending',
          error: null,
          effect_id: effectId,
          created_at: createdAt,
          sent_at: null,
        });
        this.#stmt.insertOutbox.run({ ...row, payload: JSON.stringify(row.payload) });
        rows.push(row);
      }
      return rows;
    });
  }

  getOutbox(id: string): OutboxRow | undefined {
    const row = this.#stmt.getOutbox.get(id);
    return row === undefined ? undefined : toOutboxRow(row);
  }

  outboxHeads(): OutboxRow[] {
    return this.#stmt.outboxHeads.all().map(toOutboxRow);
  }

  outboxOfChat(chatId: number): OutboxRow[] {
    return this.#stmt.outboxOfChat.all(chatId).map(toOutboxRow);
  }

  latestCardOutbox(taskId: string, round?: number): OutboxRow | undefined {
    const row = round === undefined ? this.#stmt.latestCardOutbox.get(taskId) : this.#stmt.latestCardOutboxOfRound.get(taskId, round);
    return row === undefined ? undefined : toOutboxRow(row);
  }

  markOutboxSent(id: string, sentMessageId: number | null, sentAt: string): void {
    this.#stmt.markOutboxSent.run({ id, sent_message_id: sentMessageId, sent_at: sentAt });
  }

  markOutboxAttempt(id: string, attempts: number, nextAttemptAt: string, error: string): void {
    this.#stmt.markOutboxAttempt.run({ id, attempts, next_attempt_at: nextAttemptAt, error });
  }

  markOutboxFailed(id: string, attempts: number, error: string): void {
    this.#stmt.markOutboxFailed.run({ id, attempts, error });
  }

  insertCallback(row: CallbackRow): void {
    this.#stmt.insertCallback.run({ ...callbackRowSchema.parse(row), args: JSON.stringify(row.args) });
  }

  getCallback(id: string): CallbackRow | undefined {
    const row = this.#stmt.getCallback.get(id);
    return row === undefined ? undefined : toCallbackRow(row);
  }

  insertStepRun(row: StepRun): void {
    this.#stmt.insertStepRun.run(stepRunSchema.parse(row));
  }

  getStepRun(id: string): StepRun | undefined {
    const row = this.#stmt.getStepRun.get(id);
    return row === undefined ? undefined : stepRunSchema.parse(row);
  }

  finishStepRun(id: string, end: StepRunEnd): void {
    if (this.#stmt.finishStepRun.run({ id, ...end }).changes !== 1) {
      throw new Error(`step_runs row ${id} not found`);
    }
  }

  stepRunsInStatus(statuses: readonly StepRunStatus[]): StepRun[] {
    if (statuses.length === 0) {
      return [];
    }
    return this.#db
      .prepare(`SELECT * FROM step_runs WHERE status IN (${placeholders(statuses.length)}) ORDER BY id`)
      .all(...statuses)
      .map((row) => stepRunSchema.parse(row));
  }

  acquireLease(lease: CapabilityLease): boolean {
    const row = capabilityLeaseSchema.parse(lease);
    return this.transaction(() => this.#stmt.acquireLease.run(row).changes === 1);
  }

  releaseLease(stepRunId: string): void {
    this.#stmt.releaseLease.run(stepRunId);
  }

  listLeases(): CapabilityLease[] {
    return this.#stmt.listLeases.all().map((row) => capabilityLeaseSchema.parse(row));
  }

  clearLeases(): void {
    this.#stmt.clearLeases.run();
  }

  capabilityLeasedByOtherProject(projectId: string, names: readonly string[]): boolean {
    if (names.length === 0) {
      return false;
    }
    const row = this.#db
      .prepare(
        `SELECT 1 FROM capability_leases l JOIN tasks t ON t.id = l.task_id
         WHERE t.project_id <> ? AND l.capability IN (${placeholders(names.length)}) LIMIT 1`,
      )
      .get(projectId, ...names);
    return row !== undefined;
  }

  insertTelegramMessage(row: TelegramMessageRow): void {
    this.#stmt.insertTelegramMessage.run(telegramMessageRowSchema.parse(row));
  }

  getTelegramMessage(chatId: number, messageId: number): TelegramMessageRow | undefined {
    const row = this.#stmt.getTelegramMessage.get(chatId, messageId);
    return row === undefined ? undefined : telegramMessageRowSchema.parse(row);
  }

  latestCardOfTask(taskId: string): TelegramMessageRow | undefined {
    const row = this.#stmt.latestCardOfTask.get(taskId);
    return row === undefined ? undefined : telegramMessageRowSchema.parse(row);
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
