import { z } from 'zod';
import type { StageEventRow } from './events.ts';
import type { Stage } from './stage.ts';
import { implementerOutputSchema, triageOutputSchema, validatorOutputSchema, type ImplementerOutput, type TriageOutput, type ValidatorOutput } from './stage-output/index.ts';

/**
 * What the Coordinator-run `testing` Stage stores as its output (AD-13): the step run, how it ended and
 * the tail of its log, read into the next Implementer brief. `step_run_id` is null when the Recipe has
 * no `test` step.
 */
export const testOutputSchema = z.strictObject({
  step_run_id: z.string().min(1).nullable(),
  outcome: z.string().nullable(),
  exit_code: z.int().nullable(),
  log_tail: z.string().nullable(),
});
export type TestOutput = z.infer<typeof testOutputSchema>;

export const PARKED_STATUSES = ['open', 'promoted', 'dismissed'] as const;
export type ParkedStatus = (typeof PARKED_STATUSES)[number];

/** One row of `parking_lot`: a non-blocking finding Triage parked, `P<p_no>` per Task (AD-16). */
export interface ParkedFinding {
  id: string;
  task_id: string;
  p_no: number;
  /** The Validator's `criterion_id`, as it gave it (`AC2`). */
  criterion_id: string;
  note: string;
  status: ParkedStatus;
  /** The Triage Stage that parked it. */
  source_stage_id: string | null;
  created_at: string;
}

/** One Implementer lap: the n-th Implementer Stage that returned output, with its status and summary. */
export interface Lap {
  n: number;
  status: ImplementerOutput['status'];
  summary: string;
}

/** The Stage's stored output parsed with `schema`, or undefined when it has none or another shape. */
function outputOf<T>(stage: Stage, schema: z.ZodType<T>): T | undefined {
  if (stage.output === undefined || stage.output === null) return undefined;
  const parsed = schema.safeParse(stage.output);
  return parsed.success ? parsed.data : undefined;
}

export function implementerOutputOf(stage: Stage): ImplementerOutput | undefined {
  return stage.role === 'implementer' ? outputOf(stage, implementerOutputSchema) : undefined;
}

export function validatorOutputOf(stage: Stage): ValidatorOutput | undefined {
  return stage.role === 'validator' ? outputOf(stage, validatorOutputSchema) : undefined;
}

export function triageOutputOf(stage: Stage): TriageOutput | undefined {
  return stage.role === 'triage' ? outputOf(stage, triageOutputSchema) : undefined;
}

export function testOutputOf(stage: Stage): TestOutput | undefined {
  return stage.role === 'test' ? outputOf(stage, testOutputSchema) : undefined;
}

/** Every Implementer lap of a Task, oldest first, from its `stages` rows (in insertion order). */
export function lapsOf(stages: readonly Stage[]): Lap[] {
  const laps: Lap[] = [];
  for (const stage of stages) {
    const output = implementerOutputOf(stage);
    if (output !== undefined) laps.push({ n: laps.length + 1, status: output.status, summary: output.summary });
  }
  return laps;
}

/** What ended the last lap, read from the Stages after its Implementer output (AD-21). */
export interface LastLap {
  /** The Implementer's output that opened the lap: `blocked` carries the blocker in its summary. */
  implementer: ImplementerOutput;
  /** The Validator's blocking findings. */
  blocking: ValidatorOutput['findings'];
  /** The Validator's non-blocking findings: what Triage weighs and `park` parks. */
  nonblocking: ValidatorOutput['findings'];
  /** The failed test step. */
  testFailure?: TestOutput;
  /** The Triage reason that sent the Task back. */
  triageReason?: string;
}

/**
 * The outputs of the Stages since the latest Implementer output, ignoring `current` (the Stage being
 * briefed): the last lap's blocking findings, a failed test, Triage's reason. Undefined before the first lap.
 */
export function lastLapOf(stages: readonly Stage[], current?: string): LastLap | undefined {
  const done = stages.filter((stage) => stage.id !== current && stage.output !== undefined && stage.output !== null);
  let start = -1;
  for (let i = done.length - 1; i >= 0; i--) {
    if (done[i]!.role === 'implementer') {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  const implementer = implementerOutputOf(done[start]!);
  if (implementer === undefined) return undefined;
  const lap: LastLap = { implementer, blocking: [], nonblocking: [] };
  for (const stage of done.slice(start + 1)) {
    const validator = validatorOutputOf(stage);
    if (validator !== undefined) {
      lap.blocking = validator.findings.filter((finding) => finding.blocking);
      lap.nonblocking = validator.findings.filter((finding) => !finding.blocking);
    }
    const test = testOutputOf(stage);
    if (test !== undefined && (test.outcome === 'timeout' || (test.exit_code !== null && test.exit_code !== 0))) lap.testFailure = test;
    const triage = triageOutputOf(stage);
    if (triage !== undefined) lap.triageReason = triage.reason;
  }
  return lap;
}

/**
 * The event that entered the Task's current `triage` visit: the newest applied event into `triage`
 * from another state, skipping Stage retries (`triage → triage`) and a return from `paused`.
 * `budget_spent` means the Triage decides on a spent budget (AD-3).
 */
export function triageCause(events: readonly StageEventRow[]): string | undefined {
  return enteredBy(events, 'triage');
}

/**
 * The event that entered the Task's current `stuck` visit, skipping a return from `paused`.
 * `deps_unsatisfiable` means no budget can help: no `Raise budget +2`, no `budget_raised` (AD-3).
 */
export function stuckCause(events: readonly StageEventRow[]): string | undefined {
  return enteredBy(events, 'stuck');
}

/** The newest applied event into `state` from another state, skipping Stage retries and a resume from `paused`. */
function enteredBy(events: readonly StageEventRow[], state: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const row = events[i]!;
    if (row.status !== 'applied' || row.to_state !== state) continue;
    if (row.from_state === state || row.from_state === 'paused') continue;
    return row.event_type;
  }
  return undefined;
}
