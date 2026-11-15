import { z } from 'zod';
import { RoleConfigInvalidError } from './errors.ts';
import { parseDuration } from './recipe.ts';
import { OUTPUT_SCHEMA_NAMES } from './stage-output/index.ts';

export { parseDuration };

/** The four files of a Role directory (AD-15); each resolves package ← home ← repo on its own. */
export const ROLE_FILES = ['prompt.md', 'mcp.json', 'permissions.json', 'role.yaml'] as const;
export type RoleFile = (typeof ROLE_FILES)[number];

/** A Role name is a directory name: lowercase letters, digits and dashes. */
export const ROLE_NAME = /^[a-z][a-z0-9-]*$/;

const DURATION = /^[1-9][0-9]*(ms|s|m|h)$/;

/**
 * `--permission-mode` values a Role may use. `bypassPermissions` is left out on purpose: a Stage's
 * permission policy is its `permissions.json` (AD-6).
 */
export const STAGE_PERMISSION_MODES = ['default', 'acceptEdits', 'dontAsk', 'plan'] as const;

/**
 * `role.yaml` (AD-15). `timeout`, `retries` and `max_turns` override `config.yaml` `roles.<role>`,
 * which holds the defaults; `output_schema` names one of the fixed Stage output schemas (AD-4).
 */
export const roleConfigSchema = z.strictObject({
  timeout: z.string().regex(DURATION, 'must be a duration like 45m').optional(),
  retries: z.int().nonnegative().optional(),
  max_turns: z.int().positive().optional(),
  output_schema: z.enum(OUTPUT_SCHEMA_NAMES),
  permission_mode: z.enum(STAGE_PERMISSION_MODES).default('dontAsk'),
});
export type RoleConfig = z.infer<typeof roleConfigSchema>;

/** `permissions.json`: a Claude Code settings file holding `permissions.allow` and `permissions.deny` (AD-15). */
export const permissionsSchema = z.looseObject({
  permissions: z.looseObject({
    allow: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([]),
  }),
});
export type Permissions = z.infer<typeof permissionsSchema>;

/** `mcp.json`: the only MCP servers a Stage gets (`--strict-mcp-config`, AD-4). */
export const mcpConfigSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()),
});

/** The limits a Stage launches with, after `role.yaml` is layered over `config.yaml` `roles.<role>`. */
export interface RoleLimits {
  timeout_ms: number;
  retries: number;
  max_turns: number;
}

/**
 * `role.yaml` values first, then `config.yaml` `roles.<role>`. Throws `RoleConfigInvalidError`
 * naming the first value neither layer gives.
 */
export function roleLimits(role: string, config: RoleConfig, defaults: Partial<RoleLimits> | undefined): RoleLimits {
  const timeout = config.timeout === undefined ? defaults?.timeout_ms : parseDuration(config.timeout);
  const retries = config.retries ?? defaults?.retries;
  const maxTurns = config.max_turns ?? defaults?.max_turns;
  const missing = timeout === undefined ? 'timeout' : retries === undefined ? 'retries' : maxTurns === undefined ? 'max_turns' : undefined;
  if (missing !== undefined || timeout === undefined || retries === undefined || maxTurns === undefined) {
    throw new RoleConfigInvalidError(role, `${missing ?? 'a limit'} is set neither in role.yaml nor in config.yaml roles.${role}`);
  }
  return { timeout_ms: timeout, retries, max_turns: maxTurns };
}
