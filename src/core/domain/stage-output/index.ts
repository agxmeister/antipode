import type { z } from 'zod';
import { evidenceOutputSchema } from './evidence.ts';
import { implementerOutputSchema } from './implementer.ts';
import { ownerInstructionSchema } from './owner-instruction.ts';
import { triageOutputSchema } from './triage.ts';
import { validatorOutputSchema } from './validator.ts';

export * from './evidence.ts';
export * from './implementer.ts';
export * from './owner-instruction.ts';
export * from './triage.ts';
export * from './validator.ts';

/** The fixed Stage output schemas (AD-4), by the name a `role.yaml` `output_schema` gives. */
export const OUTPUT_SCHEMAS = {
  implementer: implementerOutputSchema,
  validator: validatorOutputSchema,
  triage: triageOutputSchema,
  evidence: evidenceOutputSchema,
  'owner-instruction': ownerInstructionSchema,
} as const satisfies Record<string, z.ZodType>;

export type OutputSchemaName = keyof typeof OUTPUT_SCHEMAS;
export const OUTPUT_SCHEMA_NAMES = Object.keys(OUTPUT_SCHEMAS) as [OutputSchemaName, ...OutputSchemaName[]];
