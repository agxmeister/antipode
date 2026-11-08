import { z } from 'zod';

const id = z.string().min(1);

/**
 * Effects a transition schedules; they run after commit, in insertion order (AD-3). Handlers are
 * registered by `kind` from the composition root; a kind without a handler fails `no_handler`.
 */
export const effectSchema = z.discriminatedUnion('kind', [
  /** Launch one `claude -p` Stage attempt; its `stages` row already exists as `starting`. */
  z.strictObject({ kind: z.literal('start_stage'), stage_id: id, task_id: id, role: z.string().min(1), attempt: z.int().positive() }),
  /** Signal a Stage the Coordinator has already marked `cancelled(<reason>)`. */
  z.strictObject({ kind: z.literal('cancel_stage'), stage_id: id, task_id: id, reason: z.string().min(1) }),
  /** Run the Recipe `test` step for state `testing`; emits `test_passed` or `test_failed` with this `stage_id`. */
  z.strictObject({ kind: z.literal('run_test_step'), stage_id: id, task_id: id, attempt: z.int().positive() }),
  /** Rebase, test, revalidate, fast-forward (AD-13). */
  z.strictObject({ kind: z.literal('integrate'), task_id: id }),
  /** Run the Recipe `release` step if declared (AD-13). */
  z.strictObject({ kind: z.literal('run_release'), task_id: id }),
  /** The Mac was asleep for `gap_ms`; one per Project with an ACTIVE Task (AD-18). */
  z.strictObject({ kind: z.literal('back_online'), project_id: id, gap_ms: z.int().nonnegative() }),
  /** An Owner-facing card or notice of kind `notice_kind`; templates arrive with the Telegram stories. */
  z.strictObject({
    kind: z.literal('notify'),
    notice_kind: z.string().min(1),
    task_id: id.optional(),
    project_id: id.optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export type Effect = z.infer<typeof effectSchema>;
export type EffectKind = Effect['kind'];
export type EffectOf<K extends EffectKind> = Extract<Effect, { kind: K }>;

export const EFFECT_KINDS: readonly EffectKind[] = effectSchema.options.map(
  (option) => option.shape.kind.value as EffectKind,
);

export const effectStatusSchema = z.enum(['pending', 'done', 'failed']);
export type EffectStatus = z.infer<typeof effectStatusSchema>;

/** One row of `effects`. `effect_id` is the idempotency key handlers rely on (AD-3). */
export interface EffectRow {
  effect_id: string;
  task_id: string | null;
  kind: EffectKind;
  effect: Effect;
  status: EffectStatus;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}
