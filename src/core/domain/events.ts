import { z } from 'zod';
import { taskStateSchema } from './task.ts';

const stageId = z.string().min(1);

function plain<T extends string>(type: T) {
  return z.strictObject({ type: z.literal(type) });
}

/** A Stage or step event: carries the `stage_id` it reports on and is stale-checked (AD-3). */
function fromStage<T extends string>(type: T) {
  return z.strictObject({ type: z.literal(type), stage_id: stageId });
}

/**
 * Every event the Coordinator applies to an existing Task: the AD-3 diagram arrows, the generic
 * events of the AD-3 Rule, and the Stage lifecycle events `stage_started` and `stage_failed`.
 * Creation (`new_draft`, `bootstrap_created`) has no Task to apply to and goes through
 * `Coordinator.createTask`.
 */
export const eventSchema = z.discriminatedUnion('type', [
  // Draft and approval
  plain('draft_ready'),
  plain('draft_reply'),
  plain('approved'),
  plain('discarded'),
  plain('undone'),
  plain('undo_expired'),
  // Scheduling
  plain('deps_unmerged'),
  plain('deps_merged'),
  plain('scheduler_start'),
  z.strictObject({ type: z.literal('deps_unsatisfiable'), reason: z.string().min(1) }),
  // Stage lifecycle
  fromStage('stage_started'),
  z.strictObject({ type: z.literal('stage_failed'), stage_id: stageId, reason: z.string().min(1) }),
  z.strictObject({ type: z.literal('stage_retries_exhausted'), reason: z.string().min(1).optional() }),
  // Stage and step results
  fromStage('implementer_done'),
  fromStage('test_failed'),
  fromStage('test_passed'),
  fromStage('blocking_findings'),
  fromStage('nonblocking_findings'),
  fromStage('pass'),
  fromStage('rerun'),
  fromStage('parked'),
  z.strictObject({ type: z.literal('reason_written'), stage_id: stageId, reason: z.string().min(1) }),
  fromStage('evidence_produced'),
  fromStage('evidence_missing'),
  fromStage('evidence_rejected'),
  fromStage('evidence_verified'),
  // Review, Integration and Release
  plain('correction'),
  plain('accepted'),
  plain('rebase_or_revalidation_failed'),
  plain('merged'),
  plain('release_done'),
  plain('no_release_step'),
  plain('release_failed'),
  plain('retry_release'),
  plain('leave_it'),
  // Budget
  plain('budget_spent'),
  z.strictObject({ type: z.literal('budget_raised'), amount: z.int().positive() }),
  // Generic Owner events
  plain('cancel'),
  plain('pause'),
  plain('resume'),
  plain('amended'),
]);

export type Event = z.infer<typeof eventSchema>;
export type EventType = Event['type'];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

/** Every event type, in schema order. */
export const EVENT_TYPES: readonly EventType[] = eventSchema.options.map(
  (option) => option.shape.type.value as EventType,
);

/** Event types that carry a `stage_id`. */
export const STAGE_EVENT_TYPES: readonly EventType[] = eventSchema.options
  .filter((option) => 'stage_id' in option.shape)
  .map((option) => option.shape.type.value as EventType);

export type StageEvent = Extract<Event, { stage_id: string }>;

export function isStageEvent(event: Event): event is StageEvent {
  return 'stage_id' in event;
}

/** Events that create a Task rather than move one (the `[*]` arrows of the AD-3 diagram). */
export const CREATION_EVENT_TYPES = ['new_draft', 'bootstrap_created'] as const;
export type CreationEventType = (typeof CREATION_EVENT_TYPES)[number];

export const stageEventStatusSchema = z.enum(['applied', 'ignored']);
export const ignoreReasonSchema = z.enum(['invalid', 'stale']);
export type IgnoreReason = z.infer<typeof ignoreReasonSchema>;

/** One row of the append-only `stage_events` table: what arrived and what the Coordinator did with it. */
export const stageEventRowSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  stage_id: z.string().min(1).nullable(),
  event_type: z.string().min(1),
  /** The full event as received, JSON. */
  payload: z.string(),
  status: stageEventStatusSchema,
  ignore_reason: ignoreReasonSchema.nullable(),
  from_state: taskStateSchema.nullable(),
  to_state: taskStateSchema.nullable(),
  created_at: z.iso.datetime(),
});
export type StageEventRow = z.infer<typeof stageEventRowSchema>;
