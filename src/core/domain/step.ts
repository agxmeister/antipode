import { z } from 'zod';

/** How a step run ended (AD-7): its command exited, its timeout fired, or its exclusive capability was leased. */
export const STEP_OUTCOMES = ['exited', 'timeout', 'capability_busy'] as const;
export const stepOutcomeSchema = z.enum(STEP_OUTCOMES);
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

export const STEP_RUN_STATUSES = ['running', 'finished', 'failed'] as const;
export const stepRunStatusSchema = z.enum(STEP_RUN_STATUSES);
export type StepRunStatus = z.infer<typeof stepRunStatusSchema>;

export const STEP_RUNNERS = ['container', 'host'] as const;
export const stepRunnerKindSchema = z.enum(STEP_RUNNERS);
export type StepRunnerKind = z.infer<typeof stepRunnerKindSchema>;

const isoTimestamp = z.iso.datetime();

/**
 * One row of `step_runs` (AD-7): one execution of one Recipe step, inserted before spawning and
 * updated on exit. Its id names `data/steps/<id>/`, which holds the `log` and `out/`.
 */
export const stepRunSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  /** The Stage that asked for the step through `antipod step`; null for a Coordinator-run step. */
  stage_id: z.string().min(1).nullable(),
  step: z.string().min(1),
  runner: stepRunnerKindSchema,
  status: stepRunStatusSchema,
  outcome: stepOutcomeSchema.nullable(),
  exit_code: z.int().nullable(),
  /** Why a `failed` run failed (`restart`, `aborted`, a spawn error); null otherwise. */
  reason: z.string().nullable(),
  started_at: isoTimestamp,
  ended_at: isoTimestamp.nullable(),
});
export type StepRun = z.infer<typeof stepRunSchema>;

export type StepRunEnd = Pick<StepRun, 'status' | 'outcome' | 'exit_code' | 'reason'> & { ended_at: string };

/** One row of `capability_leases` (AD-7): an exclusive host capability held by one step run. */
export const capabilityLeaseSchema = z.object({
  capability: z.string().min(1),
  task_id: z.string().min(1),
  step_run_id: z.string().min(1),
  acquired_at: isoTimestamp,
});
export type CapabilityLease = z.infer<typeof capabilityLeaseSchema>;
