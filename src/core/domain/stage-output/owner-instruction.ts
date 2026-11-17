import { z } from 'zod';
import { evidenceKindSchema } from '../recipe.ts';

const taskNo = z.int().positive();

/** A criterion of a `new_draft`. `ac` keeps the number of a criterion the draft already has (AD-16). */
export const draftCriterionSchema = z.strictObject({
  ac: z.int().positive().optional(),
  text: z.string().min(1),
  /** A kind of the Project's Recipe `evidence_kinds` (CAP-4). */
  required_evidence: evidenceKindSchema,
  /** What the Owner asked for that the Project cannot evidence, and the substitute proposed (CAP-8). */
  infeasible: z.strictObject({ wanted: z.string().min(1), proposal: z.string().min(1) }).optional(),
});
export type DraftCriterion = z.infer<typeof draftCriterionSchema>;

/** A clarifying question of a `new_draft`, with quick answers when the answer is closed. */
export const draftQuestionSchema = z.union([
  z.string().min(1),
  z.strictObject({ text: z.string().min(1), quick_answers: z.array(z.string().min(1).max(40)).max(4).optional() }),
]);
export type DraftQuestion = z.infer<typeof draftQuestionSchema>;

/** One typed instruction Intake read from free-text Owner input (AD-9). */
export const instructionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('new_draft'),
    /** A short title for the card and the Branch; derived from the goal when absent. */
    title: z.string().min(1).max(80).optional(),
    goal: z.string().min(1),
    criteria: z.array(draftCriterionSchema),
    questions: z.array(draftQuestionSchema).max(2),
  }),
  z.strictObject({
    kind: z.literal('draft_reply'),
    draft_id: z.string().min(1),
    answers: z.array(z.string().min(1)),
    changes: z.string(),
  }),
  z.strictObject({ kind: z.literal('correction'), task: taskNo, note: z.string().min(1) }),
  z.strictObject({ kind: z.literal('amendment'), task: taskNo, changes: z.string().min(1) }),
  z.strictObject({ kind: z.literal('cancel'), task: taskNo }),
  z.strictObject({ kind: z.literal('not_actionable'), reason: z.string().min(1) }),
]);
export type Instruction = z.infer<typeof instructionSchema>;

/** What an Intake Stage returns (AD-9): one or two instructions, at most one of each kind, and an optional question. */
export const ownerInstructionSchema = z
  .strictObject({
    instructions: z.array(instructionSchema).min(1).max(2),
    question: z
      .strictObject({
        text: z.string().min(1),
        quick_answers: z.array(z.string().min(1)).optional(),
      })
      .optional(),
  })
  .refine((value) => new Set(value.instructions.map((i) => i.kind)).size === value.instructions.length, {
    message: 'at most one instruction of each kind',
    path: ['instructions'],
  });
export type OwnerInstruction = z.infer<typeof ownerInstructionSchema>;
