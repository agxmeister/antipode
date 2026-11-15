import { z } from 'zod';
import { EVIDENCE_KINDS } from '../recipe.ts';

/** One artifact the Evidence Producer made, `name` relative to `ANTIPOD_OUT` (AD-8). */
export const evidenceArtifactSchema = z.strictObject({
  name: z.string().min(1),
  criterion_id: z.string().min(1),
  kind: z.enum(EVIDENCE_KINDS),
  /** Why the artifact is weaker than the Required Evidence asked for; null when it is not. */
  degraded: z.string().nullable(),
  /** An `evidence_id` from `prior/index.json`, or the `name` of another screenshot in this list. */
  before_of: z.string().min(1).optional(),
  caption: z.string().min(1),
});

/** What an Evidence Producer Stage returns (AD-8). */
export const evidenceOutputSchema = z.strictObject({
  artifacts: z.array(evidenceArtifactSchema),
});
export type EvidenceOutput = z.infer<typeof evidenceOutputSchema>;
