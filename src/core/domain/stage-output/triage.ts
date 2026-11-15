import { z } from 'zod';

/** What a Triage Stage returns (AD-4): `rerun`, `park` or `stuck`, always with the reason. */
export const triageOutputSchema = z.strictObject({
  decision: z.enum(['rerun', 'park', 'stuck']),
  reason: z.string().min(1),
});
export type TriageOutput = z.infer<typeof triageOutputSchema>;
