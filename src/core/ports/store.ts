import type { EffectRow, EffectStatus } from '../domain/effects.ts';
import type { StageEventRow } from '../domain/events.ts';
import type { Stage, StagePatch, StageStatus } from '../domain/stage.ts';
import type { Project, Task, TaskPatch, TaskState } from '../domain/task.ts';
import type { CallbackRow, OutboxDraft, OutboxRow, TelegramMessageRow } from '../domain/telegram.ts';

/**
 * The only data access the core uses (AD-1, AD-2). Synchronous, because `applyEvent` runs inside
 * one transaction (AD-3). Implemented by `adapters/sqlite`.
 */
export interface Store {
  /** Runs `fn` in one transaction; nesting joins the outer transaction. */
  transaction<T>(fn: () => T): T;

  insertProject(project: Project): void;
  getProject(id: string): Project | undefined;
  listProjects(): Project[];
  /** Projects with at least one Task in `ACTIVE_STATES`. */
  activeProjects(): Project[];

  insertTask(task: Task): void;
  getTask(id: string): Task | undefined;
  updateTask(id: string, patch: TaskPatch & { state?: TaskState; updated_at: string }): void;
  tasksInStates(states: readonly TaskState[]): Task[];
  /** The next free per-Project Task number (AD-16). */
  nextTaskNo(projectId: string): number;
  /** Number of Tasks in any of `states`. */
  countTasksInStates(states: readonly TaskState[]): number;
  /** `queued` Tasks, oldest first (`created_at`, `id`), the order the scheduler evaluates them (AD-11). */
  queuedTasks(): Task[];
  /** Whether the Project has a `bootstrap` Task in `released` (the bootstrap gate, AD-11). */
  bootstrapReleased(projectId: string): boolean;

  /** Records that `taskId` waits for `dependsOnTaskId` to merge (CAP-15); repeating a pair is a no-op. */
  insertDependency(taskId: string, dependsOnTaskId: string): void;
  /** The Tasks `taskId` depends on, oldest first. */
  dependenciesOf(taskId: string): Task[];

  insertStage(stage: Stage): void;
  getStage(id: string): Stage | undefined;
  updateStage(id: string, patch: StagePatch): void;
  stagesInStatus(statuses: readonly StageStatus[]): Stage[];
  stagesOfTask(taskId: string): Stage[];

  /** Append-only (AD-2). */
  appendStageEvent(row: StageEventRow): void;
  stageEventsOfTask(taskId: string): StageEventRow[];

  insertEffect(row: EffectRow): void;
  getEffect(effectId: string): EffectRow | undefined;
  /** Rows still `pending`, in insertion order. */
  pendingEffects(): EffectRow[];
  effectsOfTask(taskId: string): EffectRow[];
  /**
   * The newest `notify` effect of `taskId` with `notice_kind`, in any status, whose `payload.key`
   * equals `key` (any key when omitted). Backs once-only notices.
   */
  latestNotify(taskId: string, noticeKind: string, key?: string): EffectRow | undefined;
  markEffect(effectId: string, status: EffectStatus, finishedAt: string, error?: string): void;

  /** `settings` (AD-2): instance-wide values such as `telegram.last_update_id`. */
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string, updatedAt: string): void;

  /** Binds `projectId` to a Telegram chat, or unbinds it with null. A chat binds at most one Project. */
  bindProjectChat(projectId: string, chatId: number | null): void;
  projectByChat(chatId: number): Project | undefined;

  /**
   * Appends `drafts` to the chat's outbox as one group with consecutive `sequence` numbers, in one
   * transaction. Idempotent by `effectId`: when rows of that effect exist, returns them and inserts nothing.
   */
  enqueueOutbox(chatId: number, drafts: readonly OutboxDraft[], effectId: string | null, createdAt: string): OutboxRow[];
  getOutbox(id: string): OutboxRow | undefined;
  /** The lowest-`sequence` `pending` row of every chat that has one: the head each chat drains next. */
  outboxHeads(): OutboxRow[];
  /** Every row of a chat, in `sequence` order. */
  outboxOfChat(chatId: number): OutboxRow[];
  /** The newest send of a card kind for `taskId` (and `round`, when given), in any status. */
  latestCardOutbox(taskId: string, round?: number): OutboxRow | undefined;
  markOutboxSent(id: string, sentMessageId: number | null, sentAt: string): void;
  /** Records a failed attempt that will be retried at `nextAttemptAt`. */
  markOutboxAttempt(id: string, attempts: number, nextAttemptAt: string, error: string): void;
  markOutboxFailed(id: string, attempts: number, error: string): void;

  insertCallback(row: CallbackRow): void;
  getCallback(id: string): CallbackRow | undefined;

  /** Records a sent message; a repeat of the same `(chat_id, message_id)` replaces it. */
  insertTelegramMessage(row: TelegramMessageRow): void;
  getTelegramMessage(chatId: number, messageId: number): TelegramMessageRow | undefined;
  /** The newest card message of `taskId` (kind ending `_card`), if any was sent. */
  latestCardOfTask(taskId: string): TelegramMessageRow | undefined;
}
