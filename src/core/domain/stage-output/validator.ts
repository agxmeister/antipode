import { z } from 'zod';

export const validatorFindingSchema = z.strictObject({
  criterion_id: z.string().min(1),
  blocking: z.boolean(),
  note: z.string().min(1),
});

export const evidenceVerdictSchema = z.strictObject({
  evidence_id: z.string().min(1),
  shows_criterion: z.boolean(),
  note: z.string().min(1),
});

/**
 * What a Validator Stage returns (AD-4). In Evidence mode (state `verifying`) it also carries
 * `evidence_verdicts`, one per Evidence artifact it judged.
 */
export const validatorOutputSchema = z
  .strictObject({
    verdict: z.enum(['pass', 'blocking', 'nonblocking']),
    findings: z.array(validatorFindingSchema),
    evidence_verdicts: z.array(evidenceVerdictSchema).optional(),
  })
  // The verdict must agree with the findings: `blocking` exactly when some finding blocks.
  .superRefine((value, ctx) => {
    const blocking = value.findings.some((finding) => finding.blocking);
    if (value.verdict === 'blocking' && !blocking) {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'blocking needs at least one blocking finding' });
    }
    if (value.verdict !== 'blocking' && blocking) {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `${value.verdict} cannot have a blocking finding` });
    }
  });
export type ValidatorOutput = z.infer<typeof validatorOutputSchema>;
