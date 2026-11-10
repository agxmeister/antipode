import { z } from 'zod';

/** One usage window as the reader reports it: percent used and when it resets. */
export const usageWindowSchema = z.object({
  /** Percent of the window used, 0–100 (may exceed 100 when over the limit). */
  utilization: z.number().nonnegative(),
  resets_at: z.iso.datetime({ offset: true }),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

/** The AD-12 reading: the five-hour and weekly windows of the Owner's plan. */
export const usageReadingSchema = z.object({
  five_hour: usageWindowSchema,
  weekly: usageWindowSchema,
});
export type UsageReading = z.infer<typeof usageReadingSchema>;

/**
 * The usage-window seam (AD-12). Implemented by `anthropic-usage`; `null` means no reading
 * (the core estimator over `cost_samples` is the fallback, story 1-16).
 */
export interface WindowReader {
  read(): Promise<UsageReading | null>;
}
