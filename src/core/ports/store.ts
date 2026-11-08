import type { EffectRow, EffectStatus } from '../domain/effects.ts';
import type { StageEventRow } from '../domain/events.ts';
import type { Stage, StagePatch, StageStatus } from '../domain/stage.ts';
import type { Project, Task, TaskPatch, TaskState } from '../domain/task.ts';

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
  markEffect(effectId: string, status: EffectStatus, finishedAt: string, error?: string): void;
}
