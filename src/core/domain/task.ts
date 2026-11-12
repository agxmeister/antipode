import { z } from 'zod';

/** Every Task state of the AD-3 diagram, in diagram order. */
export const TASK_STATES = [
  'draft',
  'awaiting_approval',
  'discard_pending',
  'queued',
  'waiting_on_dependencies',
  'implementing',
  'testing',
  'validating',
  'triage',
  'evidencing',
  'verifying',
  'in_review',
  'accept_pending',
  'integrating',
  'merged',
  'release_failed',
  'released',
  'cancelled',
  'stuck',
  'paused',
] as const;

export const taskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof taskStateSchema>;

/** `ACTIVE` as AD-3 lists it. */
export const ACTIVE_STATES: readonly TaskState[] = [
  'queued',
  'waiting_on_dependencies',
  'implementing',
  'testing',
  'validating',
  'triage',
  'evidencing',
  'verifying',
  'in_review',
  'integrating',
  'stuck',
  'paused',
];

export const TERMINAL_STATES: readonly TaskState[] = ['released', 'cancelled'];

/** Why a Task is not starting or launching its next Stage: the failing AD-11 gate, shown by `/status`. */
export const WAITING_REASONS = ['paused', 'usage_window', 'concurrency', 'open_reviews', 'bootstrap'] as const;
export const waitingReasonSchema = z.enum(WAITING_REASONS);
export type WaitingReason = z.infer<typeof waitingReasonSchema>;

export const TASK_KINDS = ['feature', 'bootstrap'] as const;
export const taskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof taskKindSchema>;

const isoTimestamp = z.iso.datetime();

export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  paused_at: isoTimestamp.nullable(),
  /** The Telegram supergroup bound by `/register` (AD-10); null until bound. */
  telegram_chat_id: z.int().nullable(),
  /** The remote the Project was registered from (AD-5); unique, null only for Projects made outside registration. */
  repo_url: z.string().min(1).nullable(),
  created_at: isoTimestamp,
});
export type Project = z.infer<typeof projectSchema>;

/** A Project's name as Owner-facing copy shows it: the Recipe `name` with its first letter upper-cased. */
export function projectDisplayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** One row of `tasks`: the current state of a Task. Events are history, never replayed (AD-3). */
export const taskSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  kind: taskKindSchema,
  /** Per-Project sequential number, assigned at approval or bootstrap creation (AD-16). */
  task_no: z.int().positive().nullable(),
  state: taskStateSchema,
  current_stage_id: z.string().min(1).nullable(),
  budget_used: z.int().nonnegative(),
  budget_limit: z.int().positive(),
  review_round: z.int().nonnegative(),
  resume_state: taskStateSchema.nullable(),
  stuck_reason: z.string().nullable(),
  waiting_reason: z.string().nullable(),
  undo_expires_at: isoTimestamp.nullable(),
  config_sha: z.string().nullable(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});
export type Task = z.infer<typeof taskSchema>;

/** Columns a transition may change; identity, kind and `state` are set by the Coordinator itself. */
export type TaskPatch = Partial<Omit<Task, 'id' | 'project_id' | 'kind' | 'state' | 'created_at' | 'updated_at'>>;
