import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigInvalidError, type ConfigIssue } from '../core/domain/errors.ts';

const positiveInt = z.int().positive();
const nonNegativeInt = z.int().nonnegative();

/** `roles.<role>`: the `role.yaml` values of config-defaults.md (file layering per AD-15 is story 1-7). */
function roleSchema(defaults: { timeout_ms: number; retries: number; max_turns: number }) {
  return z
    .strictObject({
      timeout_ms: positiveInt.default(defaults.timeout_ms),
      retries: nonNegativeInt.default(defaults.retries),
      max_turns: positiveInt.default(defaults.max_turns),
    })
    .prefault({});
}

const MINUTE = 60_000;

/**
 * `$ANTIPOD_HOME/config.yaml` (AD-15). Defaults come from docs/specs/spec-antipod/config-defaults.md.
 * Objects are strict so a mistyped key is reported instead of silently ignored.
 */
export const configSchema = z.strictObject({
  owner: z
    .strictObject({
      telegram_user_id: positiveInt,
    })
    // Parsing `{}` when `owner` is absent reports the missing key as `owner.telegram_user_id`.
    .prefault({} as { telegram_user_id: number }),
  agent: z
    .strictObject({
      auth: z.enum(['subscription', 'api-key']).default('subscription'),
    })
    .prefault({}),
  limits: z
    .strictObject({
      iteration_budget: positiveInt.default(5),
      concurrency: z.int().min(1).max(3).default(2),
      open_reviews: positiveInt.default(3),
      undo_accept_ms: nonNegativeInt.default(10_000),
      undo_discard_ms: nonNegativeInt.default(60_000),
    })
    .prefault({}),
  usage: z
    .strictObject({
      pause_at_percent: z.number().min(0).max(100).default(85),
      poll_interval_ms: positiveInt.default(60_000),
    })
    .prefault({}),
  intake: z
    .strictObject({
      retries: nonNegativeInt.default(2),
      context_messages: nonNegativeInt.default(10),
    })
    .prefault({}),
  outbox: z
    .strictObject({
      retries: nonNegativeInt.default(5),
    })
    .prefault({}),
  telegram: z
    .strictObject({
      stale_after_ms: positiveInt.default(300_000),
    })
    .prefault({}),
  roles: z
    .strictObject({
      intake: roleSchema({ timeout_ms: 5 * MINUTE, retries: 2, max_turns: 25 }),
      implementer: roleSchema({ timeout_ms: 45 * MINUTE, retries: 2, max_turns: 150 }),
      validator: roleSchema({ timeout_ms: 20 * MINUTE, retries: 2, max_turns: 60 }),
      'evidence-producer': roleSchema({ timeout_ms: 30 * MINUTE, retries: 2, max_turns: 80 }),
      triage: roleSchema({ timeout_ms: 5 * MINUTE, retries: 2, max_turns: 15 }),
    })
    .prefault({}),
  backup: z
    .strictObject({
      path: z.string().min(1).refine(isAbsolute, 'must be an absolute path').optional(),
    })
    .prefault({}),
  /** Host capability name → command on this host (AD-19). */
  capabilities: z.record(z.string().min(1), z.string().min(1)).default({}),
  logging: z
    .strictObject({
      level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;

function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(root)' : path.map((part) => String(part)).join('.');
}

/** Validates an already-parsed YAML document; throws `ConfigInvalidError` naming each failing key path. */
export function parseConfig(document: unknown, file = 'config.yaml'): Config {
  const result = configSchema.safeParse(document ?? {});
  if (result.success) {
    return result.data;
  }
  const issues: ConfigIssue[] = [];
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        issues.push({ path: issuePath([...issue.path, key]), message: 'unknown key' });
      }
    } else {
      issues.push({ path: issuePath(issue.path), message: issue.message });
    }
  }
  throw new ConfigInvalidError(file, issues);
}

/** Reads and validates `config.yaml`. */
export function loadConfig(file: string): Config {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new ConfigInvalidError(file, [{ path: '(file)', message: `cannot read config file (${code})` }], {
      cause: error,
    });
  }
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
    throw new ConfigInvalidError(file, [{ path: '(yaml)', message }], { cause: error });
  }
  return parseConfig(document, file);
}
