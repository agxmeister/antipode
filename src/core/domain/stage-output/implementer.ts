import { z } from 'zod';

/** What an Implementer Stage returns (AD-4): `done` maps to `implementer_done`; `blocked` goes through the Role's output hook. */
export const implementerOutputSchema = z.strictObject({
  status: z.enum(['done', 'blocked']),
  /** What was changed, or why the Stage is blocked. */
  summary: z.string().min(1),
});
export type ImplementerOutput = z.infer<typeof implementerOutputSchema>;
