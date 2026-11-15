import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { RoleConfigInvalidError, UnknownRoleError } from '../../core/domain/errors.ts';
import {
  mcpConfigSchema,
  permissionsSchema,
  ROLE_FILES,
  ROLE_NAME,
  roleConfigSchema,
  type Permissions,
  type RoleConfig,
  type RoleFile,
} from '../../core/domain/role.ts';

/** Where a Role file came from, later layers winning (AD-15). */
export type RoleLayer = 'package' | 'home' | 'repo';

/** The repo directory of Role overrides, read only from the bare clone at `tasks.config_sha` (AD-22). */
export const REPO_ROLES_DIR = '.antipod/roles';

/** Reads `path` from the repo at the Task's pinned commit; undefined when no file is there. */
export type RepoFileReader = (path: string) => Promise<string | undefined>;

export interface RoleConfigResolverOptions {
  /** The package's `roles/`. */
  packageDir: string;
  /** `$ANTIPOD_HOME/roles/`. */
  homeDir: string;
}

/** A Role with each of its four files taken from the last layer that has it. */
export interface ResolvedRole {
  name: string;
  files: Record<RoleFile, string>;
  sources: Record<RoleFile, RoleLayer>;
  config: RoleConfig;
  permissions: Permissions;
}

/** Values substituted into `permissions.json` rules when a Role is materialized for one Stage. */
export interface RoleVars {
  ANTIPOD_HOME: string;
  /** The Stage's `cwd`: the Task worktree, or `_main` for Intake. */
  WORKTREE: string;
  ANTIPOD_PRIOR: string;
  /** Every worktree but the Stage's own; a rule naming it is repeated once per entry and dropped when there is none. */
  OTHER_WORKTREES: readonly string[];
}

/** The materialized files a launch passes to `claude` (AD-4). */
export interface MaterializedRole {
  dir: string;
  settingsPath: string;
  mcpConfigPath: string;
  systemPromptPath: string;
}

const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g;

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
}

/**
 * Expands `{{NAME}}` in every rule of `permissions.json`. A rule naming `OTHER_WORKTREES` becomes
 * one rule per other worktree. Throws on an unknown placeholder.
 */
export function expandPermissions(role: string, permissions: Permissions, vars: RoleVars): Permissions {
  const replace = (rule: string, other: string | undefined): string =>
    // A function replacer, so `$&`-style patterns in a path are taken literally.
    rule.replace(PLACEHOLDER, (match, name: string) => {
      if (name === 'ANTIPOD_HOME' || name === 'WORKTREE' || name === 'ANTIPOD_PRIOR') return vars[name];
      if (name === 'OTHER_WORKTREES' && other !== undefined) return other;
      throw new RoleConfigInvalidError(role, `permissions.json uses unknown placeholder ${match}`);
    });
  const expand = (rules: readonly string[]): string[] =>
    rules.flatMap((rule) => {
      if (rule.includes('{{OTHER_WORKTREES}}')) {
        // Checked once even when there is no other worktree, so an unknown placeholder never hides.
        replace(rule, '');
        return vars.OTHER_WORKTREES.map((dir) => replace(rule, dir));
      }
      return [replace(rule, undefined)];
    });
  return {
    ...permissions,
    permissions: { ...permissions.permissions, allow: expand(permissions.permissions.allow), deny: expand(permissions.permissions.deny) },
  };
}

/**
 * The Role Config resolver (AD-15, AD-22): each of `prompt.md`, `mcp.json`, `permissions.json` and
 * `role.yaml` resolves package `roles/<role>/` ← `$ANTIPOD_HOME/roles/<role>/` ← repo
 * `.antipod/roles/<role>/` at the Task's pinned commit, file by file.
 */
export class RoleConfigResolver {
  readonly #options: RoleConfigResolverOptions;

  constructor(options: RoleConfigResolverOptions) {
    this.#options = options;
  }

  /**
   * Resolves `role`. `repo` reads the repo layer at `tasks.config_sha`; without one there is no repo
   * layer. Throws `UnknownRoleError` when no layer has any file of the Role, `RoleConfigInvalidError`
   * when a file is missing everywhere or does not validate.
   */
  async resolve(role: string, repo?: RepoFileReader): Promise<ResolvedRole> {
    if (!ROLE_NAME.test(role)) {
      throw new UnknownRoleError(role);
    }
    const files: Partial<Record<RoleFile, string>> = {};
    const sources: Partial<Record<RoleFile, RoleLayer>> = {};
    for (const file of ROLE_FILES) {
      const layers: Array<[RoleLayer, () => Promise<string | undefined>]> = [
        ['repo', async () => (repo === undefined ? undefined : repo(`${REPO_ROLES_DIR}/${role}/${file}`))],
        ['home', () => readIfExists(join(this.#options.homeDir, role, file))],
        ['package', () => readIfExists(join(this.#options.packageDir, role, file))],
      ];
      for (const [layer, read] of layers) {
        const text = await read();
        if (text !== undefined) {
          files[file] = text;
          sources[file] = layer;
          break;
        }
      }
    }
    const found = ROLE_FILES.filter((file) => files[file] !== undefined);
    if (found.length === 0) {
      throw new UnknownRoleError(role);
    }
    const missing = ROLE_FILES.filter((file) => files[file] === undefined);
    if (missing.length > 0) {
      throw new RoleConfigInvalidError(role, `${missing.join(', ')} found in no layer`);
    }
    const complete = files as Record<RoleFile, string>;
    const config = this.#parse(role, 'role.yaml', () => roleConfigSchema.parse(parseYaml(complete['role.yaml']) ?? {}));
    const permissions = this.#parse(role, 'permissions.json', () => permissionsSchema.parse(JSON.parse(complete['permissions.json'])));
    this.#parse(role, 'mcp.json', () => mcpConfigSchema.parse(JSON.parse(complete['mcp.json'])));
    return { name: role, files: complete, sources: sources as Record<RoleFile, RoleLayer>, config, permissions };
  }

  #parse<T>(role: string, file: RoleFile, parse: () => T): T {
    try {
      return parse();
    } catch (error) {
      throw new RoleConfigInvalidError(role, `${file} is invalid: ${errorText(error)}`);
    }
  }

  /**
   * Writes the resolved files to `dir` (`data/stages/<stage_id>/role/`), with the placeholders of
   * `permissions.json` expanded, and returns the paths the launch passes to `claude`.
   */
  async materialize(resolved: ResolvedRole, dir: string, vars: RoleVars): Promise<MaterializedRole> {
    const permissions = expandPermissions(resolved.name, resolved.permissions, vars);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const paths: MaterializedRole = {
      dir,
      settingsPath: join(dir, 'permissions.json'),
      mcpConfigPath: join(dir, 'mcp.json'),
      systemPromptPath: join(dir, 'prompt.md'),
    };
    await writeFile(paths.settingsPath, `${JSON.stringify(permissions, null, 2)}\n`, { mode: 0o600 });
    await writeFile(paths.mcpConfigPath, resolved.files['mcp.json'], { mode: 0o600 });
    await writeFile(paths.systemPromptPath, resolved.files['prompt.md'], { mode: 0o600 });
    await writeFile(join(dir, 'role.yaml'), resolved.files['role.yaml'], { mode: 0o600 });
    return paths;
  }
}
