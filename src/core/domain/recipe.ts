import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** The Recipe lives at the repo root (AD-5), read from `origin/main` at a recorded SHA (AD-22). */
export const RECIPE_FILE = 'antipod.yaml';

/** Evidence kinds a Recipe may declare (AD-8). */
export const EVIDENCE_KINDS = ['screenshot', 'screencast', 'render', 'composite', 'test_result', 'measurement', 'file'] as const;
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

/** Step names AD-7 reserves for the Coordinator's own use. */
export const RESERVED_STEPS = ['build', 'test', 'evidence', 'demo', 'release'] as const;
/** The one step that may reference `PROD_` secrets (AD-14). */
export const RELEASE_STEP = 'release';
export const PROD_PREFIX = 'PROD_';

/** A key under which a 16+ character string is a secret value (AD-14). */
export const SECRET_KEY = /secret|token|password|passwd|key|credential|auth/i;
export const SECRET_VALUE_MIN = 16;

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
const STEP_NAME = /^[a-z][a-z0-9_-]*$/;
/** `15m`, `90s`, `2h`, `500ms`. */
const DURATION = /^[1-9][0-9]*(ms|s|m|h)$/;
const PROD_REFERENCE = /\bPROD_[A-Z0-9_]*/;

/** A path inside the parsed Recipe tree, as zod reports it. */
export type RecipePath = ReadonlyArray<string | number>;

function relativePath(what: string) {
  return z
    .string({ error: `must be a ${what}` })
    .min(1, 'must not be empty')
    .refine((value) => !isAbsolute(value) && !value.split(/[\\/]/).includes('..'), 'must be a path inside the repo');
}

export const recipeStepSchema = z
  .strictObject({
    runner: z.enum(['container', 'host'], { error: 'must be container or host' }),
    image: z.string({ error: 'must be a string' }).min(1, 'must not be empty').optional(),
    capability: z.string({ error: 'must be a string' }).min(1, 'must not be empty').optional(),
    cmd: z.string({ error: 'must be a string' }).min(1, 'must not be empty'),
    timeout: z.string({ error: 'must be a duration like 15m' }).regex(DURATION, 'must be a duration like 15m'),
    secrets: z.array(z.string({ error: 'must be a secret name' }).regex(SECRET_NAME, 'must be a secret name like API_TOKEN'), { error: 'must be a list of secret names' }).default([]),
    outputs: relativePath('relative path').optional(),
    exclusive: z.boolean({ error: 'must be true or false' }).default(false),
  })
  .superRefine((step, ctx) => {
    if (step.runner === 'container' && step.image === undefined) {
      ctx.addIssue({ code: 'custom', path: ['image'], message: 'is required for a container step' });
    }
    if (step.runner === 'host' && step.capability === undefined) {
      ctx.addIssue({ code: 'custom', path: ['capability'], message: 'is required for a host step' });
    }
  });
export type RecipeStep = z.infer<typeof recipeStepSchema>;

/**
 * `antipod.yaml` (AD-7, spine Recipe seed). Steps are strict; unknown top-level keys are kept, because
 * the Recipe is also the Project layer of settings (AD-15).
 */
export const recipeSchema = z
  .looseObject({
    name: z.string({ error: 'must be a string' }).regex(PROJECT_NAME, 'must be lowercase letters, digits and dashes, like training'),
    evidence_kinds: z
      .array(z.enum(EVIDENCE_KINDS, { error: `must be one of ${EVIDENCE_KINDS.join(', ')}` }), { error: 'must be a list of Evidence kinds' })
      .min(1, 'must list at least one Evidence kind'),
    demo: z
      .strictObject({
        kind: z.enum(EVIDENCE_KINDS, { error: `must be one of ${EVIDENCE_KINDS.join(', ')}` }),
        step: z.string({ error: 'must be a step name' }).min(1, 'must not be empty'),
      })
      .nullable()
      .default(null),
    fixtures: relativePath('relative path or null').nullable().default(null),
    steps: z.record(z.string().regex(STEP_NAME, 'must be a step name like build'), recipeStepSchema, { error: 'must be a mapping of steps' }),
  })
  .superRefine((recipe, ctx) => {
    if (recipe.demo !== null && !(recipe.demo.step in recipe.steps)) {
      ctx.addIssue({ code: 'custom', path: ['demo', 'step'], message: "must name one of the steps" });
    }
  });
export type Recipe = z.infer<typeof recipeSchema>;

/** One problem, located in the Recipe tree; callers map the path to a line. */
export interface RecipeIssue {
  path: RecipePath;
  message: string;
}

/** The first issue of a failed parse, worded for `Recipe invalid: <path> <message>`. */
export function firstRecipeIssue(error: z.ZodError): RecipeIssue {
  const issue = error.issues[0];
  if (issue === undefined) return { path: [], message: 'is invalid' };
  const path = issue.path.filter((part): part is string | number => typeof part !== 'symbol');
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined) return { path, message: 'is required' };
      if (path.length === 0) return { path, message: 'must be a mapping' };
      return { path, message: issue.message.startsWith('must') ? issue.message : `must be a ${issue.expected}` };
    case 'unrecognized_keys':
      return { path: [...path, issue.keys[0] ?? ''], message: 'is not a known key' };
    case 'invalid_key':
      return { path, message: 'must be a step name like build' };
    default:
      return { path, message: issue.message };
  }
}

/**
 * The first secret value in a parsed Recipe tree: a string of `SECRET_VALUE_MIN`+ characters under a
 * key matching `SECRET_KEY` (list items inherit their list's key). Items of a step's `secrets:` list
 * are names, not values, and are skipped.
 */
export function findSecretValue(tree: unknown): RecipePath | undefined {
  const walk = (node: unknown, path: Array<string | number>, key: string | undefined): RecipePath | undefined => {
    if (typeof node === 'string') {
      return key !== undefined && SECRET_KEY.test(key) && node.length >= SECRET_VALUE_MIN ? path : undefined;
    }
    if (Array.isArray(node)) {
      if (path.length === 3 && path[0] === 'steps' && path[2] === 'secrets') return undefined;
      for (const [index, item] of node.entries()) {
        const found = walk(item, [...path, index], key);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (node !== null && typeof node === 'object') {
      for (const [child, value] of Object.entries(node)) {
        const found = walk(value, [...path, child], child);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return walk(tree, [], undefined);
}

/** The first `PROD_` reference outside the `release` step (AD-14): a `secrets:` name or one in `cmd`. */
export function findProdMisuse(recipe: Recipe): { name: string; path: RecipePath } | undefined {
  for (const [step, definition] of Object.entries(recipe.steps)) {
    if (step === RELEASE_STEP) continue;
    for (const [index, secret] of definition.secrets.entries()) {
      if (secret.startsWith(PROD_PREFIX)) return { name: secret, path: ['steps', step, 'secrets', index] };
    }
    const inCmd = PROD_REFERENCE.exec(definition.cmd);
    if (inCmd !== null) return { name: inCmd[0], path: ['steps', step, 'cmd'] };
  }
  return undefined;
}
