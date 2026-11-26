import type { ContractRow, ContractSourceRow, CriterionRow, DraftQuestionRow, IntakeMessageRow } from '../domain/contract.ts';
import type { EffectRow, EffectStatus } from '../domain/effects.ts';
import type { StageEventRow } from '../domain/events.ts';
import type { ParkedFinding } from '../domain/loop.ts';
import type { Stage, StagePatch, StageStatus } from '../domain/stage.ts';
import type { CapabilityLease, StepRun, StepRunEnd, StepRunStatus } from '../domain/step.ts';
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
  /** The Project registered from `repoUrl` (as `Repo.remoteUrl` resolved it). */
  projectByRepo(repoUrl: string): Project | undefined;
  projectByName(name: string): Project | undefined;
  /** Projects with at least one Task in `ACTIVE_STATES`. */
  activeProjects(): Project[];
  /** Replaces the Project's exclusive capability names (registration, from the validated Recipe; AD-11). */
  setProjectExclusiveCapabilities(projectId: string, names: readonly string[]): void;

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

  /** The Task numbered `taskNo` in the Project (AD-16). */
  taskByNo(projectId: string, taskNo: number): Task | undefined;

  /** Inserts one version of a Task's contract (AD-21). */
  insertContract(row: ContractRow): void;
  /** The highest version of the Task's contract. */
  latestContract(taskId: string): ContractRow | undefined;
  /** Inserts or replaces the criterion `(task_id, ac_no)`. */
  saveCriterion(row: CriterionRow): void;
  /** Every criterion of the Task, dropped ones included, `ac_no` order. */
  criteriaOf(taskId: string): CriterionRow[];
  insertQuestion(row: DraftQuestionRow): void;
  /** Every question of the draft, `q_no` order. */
  questionsOf(taskId: string): DraftQuestionRow[];
  /** Records the answer of an open question; false when it does not exist or is already answered. */
  answerQuestion(taskId: string, qNo: number, answer: string): boolean;
  /** Deletes the draft's unanswered questions (a revision replaces them). */
  deleteOpenQuestions(taskId: string): void;
  /** Records an imported inbox file (AD-5). */
  insertContractSource(row: ContractSourceRow): void;
  getContractSource(projectId: string, path: string, blobSha: string): ContractSourceRow | undefined;
  /** Every recorded blob at `path` in the Project, oldest first. */
  contractSourcesAt(projectId: string, path: string): ContractSourceRow[];
  /** The inbox file a Task came from, if it came from one. */
  contractSourceOfTask(taskId: string): ContractSourceRow | undefined;
  insertIntakeMessage(row: IntakeMessageRow): void;
  /** Every Intake message of the Task, oldest first. */
  intakeMessagesOf(taskId: string): IntakeMessageRow[];

  /** Records that `taskId` waits for `dependsOnTaskId` to merge (CAP-15); repeating a pair is a no-op. */
  insertDependency(taskId: string, dependsOnTaskId: string): void;
  /** The Tasks `taskId` depends on, oldest first. */
  dependenciesOf(taskId: string): Task[];

  insertStage(stage: Stage): void;
  getStage(id: string): Stage | undefined;
  updateStage(id: string, patch: StagePatch): void;
  stagesInStatus(statuses: readonly StageStatus[]): Stage[];
  /** The Task's Stage attempts in insertion order; only those of `role` when given. */
  stagesOfTask(taskId: string, role?: string): Stage[];
  /** Stores a Stage attempt's typed output as JSON (AD-21); called in the transaction of the event it mapped to. */
  setStageOutput(stageId: string, output: unknown): void;

  /**
   * Parks `findings` as `open` Parking Lot rows numbered `P<n>` after the Task's highest (AD-16), from
   * the Triage Stage `sourceStageId`. Returns the rows inserted.
   */
  insertParkedFindings(taskId: string, sourceStageId: string, findings: ReadonlyArray<{ criterion_id: string; note: string }>, createdAt: string): ParkedFinding[];
  /** Every Parking Lot row of the Task, `p_no` order. */
  parkedFindings(taskId: string): ParkedFinding[];

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
  /**
   * Every render of one sent message, in `sequence` order: the `send*` row whose `sent_message_id` it is,
   * then each row of the chat aimed at it by `target_message_id` or at that send row by `target_outbox_id`.
   */
  rendersOfMessage(chatId: number, messageId: number): OutboxRow[];
  markOutboxSent(id: string, sentMessageId: number | null, sentAt: string): void;
  /** Records a failed attempt that will be retried at `nextAttemptAt`. */
  markOutboxAttempt(id: string, attempts: number, nextAttemptAt: string, error: string): void;
  markOutboxFailed(id: string, attempts: number, error: string): void;

  insertCallback(row: CallbackRow): void;
  getCallback(id: string): CallbackRow | undefined;

  /** Inserts a `step_runs` row before its step is spawned (AD-7). */
  insertStepRun(row: StepRun): void;
  getStepRun(id: string): StepRun | undefined;
  /** Records how a step run ended. */
  finishStepRun(id: string, end: StepRunEnd): void;
  stepRunsInStatus(statuses: readonly StepRunStatus[]): StepRun[];

  /** Takes the lease on `lease.capability` in one transaction; false, inserting nothing, when any lease on it exists (AD-7). */
  acquireLease(lease: CapabilityLease): boolean;
  /** Releases every lease `stepRunId` holds; none is fine. */
  releaseLease(stepRunId: string): void;
  listLeases(): CapabilityLease[];
  /** Deletes every lease (boot recovery, AD-18). */
  clearLeases(): void;
  /** Whether any of `names` is leased by a Task of a Project other than `projectId` (AD-11 hint gate). */
  capabilityLeasedByOtherProject(projectId: string, names: readonly string[]): boolean;

  /** Records a sent message; a repeat of the same `(chat_id, message_id)` replaces it. */
  insertTelegramMessage(row: TelegramMessageRow): void;
  getTelegramMessage(chatId: number, messageId: number): TelegramMessageRow | undefined;
  /** The newest card message of `taskId` (kind ending `_card`), if any was sent. */
  latestCardOfTask(taskId: string): TelegramMessageRow | undefined;
}
