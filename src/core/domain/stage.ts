import { z } from 'zod';

export const STAGE_STATUSES = ['starting', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const stageStatusSchema = z.enum(STAGE_STATUSES);
export type StageStatus = z.infer<typeof stageStatusSchema>;

/** Statuses in which a Stage's events are still applied (AD-3). */
export const LIVE_STAGE_STATUSES: readonly StageStatus[] = ['starting', 'running'];

/**
 * One row of `stages`: one attempt of one Stage. Role `test` is the Coordinator-run Recipe
 * `test` step (state `testing`), tracked as a Stage so its result events carry a `stage_id` and
 * a crash during it recovers like any other Stage (AD-18).
 */
export const stageSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  role: z.string().min(1),
  attempt: z.int().positive(),
  status: stageStatusSchema,
  /** `failed(<reason>)` or `cancelled(<reason>)`; null otherwise. */
  reason: z.string().nullable(),
  created_at: z.iso.datetime(),
  started_at: z.iso.datetime().nullable(),
  ended_at: z.iso.datetime().nullable(),
  /**
   * `retries` of the resolved Role Config, stored when the Stage is launched so the synchronous
   * retry rule reads it (AD-4, AD-15); null until then, and for the `test` step.
   */
  retries: z.int().nonnegative().nullish(),
});
export type Stage = z.infer<typeof stageSchema>;

export type StagePatch = Partial<Pick<Stage, 'status' | 'reason' | 'started_at' | 'ended_at' | 'retries'>>;

const count = z.int().nonnegative().nullable();

/**
 * Tokens, estimated cost and wall time of one Stage attempt, read from the final `result` message
 * of its stream (AD-4, AD-12). A field is null when the message did not give it.
 */
export const stageUsageSchema = z.strictObject({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count,
  cache_creation_input_tokens: count,
  cost_usd: z.number().nonnegative().nullable(),
  duration_ms: count,
});
export type StageUsage = z.infer<typeof stageUsageSchema>;

export function isLiveStage(stage: Stage | undefined): stage is Stage {
  return stage !== undefined && LIVE_STAGE_STATUSES.includes(stage.status);
}
