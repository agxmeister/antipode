import { z } from 'zod';

const taskNo = z.int().positive();

/** One typed instruction Intake read from free-text Owner input (AD-9). */
export const instructionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('new_draft'),
    goal: z.string().min(1),
    criteria: z.array(z.strictObject({ text: z.string().min(1), required_evidence: z.string().min(1) })),
    questions: z.array(z.string().min(1)).max(2),
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
