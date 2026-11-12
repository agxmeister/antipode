import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { RepoUnreachableError } from '../../core/domain/errors.ts';
import { silentLog, type Log } from '../../core/ports/log.ts';
import { STAGING_PREFIX, type Repo } from '../../core/ports/repo.ts';

/** The refspec every bare clone fetches with (AD-5); `git clone --bare` alone sets none. */
export const FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';
export const MAIN_REF = 'refs/remotes/origin/main';
/** The instance deploy key (AD-14), used through `GIT_SSH_COMMAND` only when it exists. */
export const DEPLOY_KEY = 'id_antipod';
/** Name of the read-only checkout of `main` under `data/worktrees/<project>/`. */
export const MAIN_CHECKOUT = '_main';

const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitRepoOptions {
  /** `$ANTIPOD_HOME/data`: clones go to `repos/`, worktrees to `worktrees/` (AD-5). */
  dataDir: string;
  /** `$ANTIPOD_HOME/secrets`, where `id_antipod` may live. */
  secretsDir: string;
  log?: Log;
}

/** `host/owner/repo` → `git@host:owner/repo.git`; a scheme, `git@` or an absolute path is used as given. */
export function remoteUrl(repo: string): string {
  const trimmed = repo.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('git@') || isAbsolute(trimmed)) {
    return trimmed;
  }
  const match = /^([^/\s:]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  return match === null ? trimmed : `git@${match[1]}:${match[2]}/${match[3]}.git`;
}

/** The environment every git call runs with: no prompts, and the deploy key when there is one (AD-14). */
export function gitEnv(secretsDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: '0' };
  delete env['GIT_SSH_COMMAND'];
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  const key = join(secretsDir, DEPLOY_KEY);
  if (existsSync(key)) {
    env['GIT_SSH_COMMAND'] = `ssh -i '${key.replaceAll("'", "'\\''")}' -o IdentitiesOnly=yes -o BatchMode=yes`;
  }
  return env;
}

/** The first line of git's stderr that says what went wrong (progress lines such as `Cloning into` skipped). */
export function firstErrorLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^(Cloning into|remote: (Enumerating|Counting|Compressing|Total))/.test(line));
  return lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0] ?? 'git failed';
}

class GitError extends Error {
  readonly stderr: string;
  readonly exitCode: number | string | undefined;

  constructor(args: readonly string[], stderr: string, exitCode: number | string | undefined) {
    super(`git ${args.join(' ')} failed: ${firstErrorLine(stderr)}`);
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/**
 * The `git` adapter behind `Repo` (AD-5): one plain bare clone per Project at `data/repos/<name>.git`,
 * a read-only `_main` checkout and one worktree per Task under `data/worktrees/<name>/`. Every call is
 * a `git` subprocess with `GIT_TERMINAL_PROMPT=0`.
 */
export class GitRepo implements Repo {
  readonly #reposDir: string;
  readonly #worktreesDir: string;
  readonly #secretsDir: string;
  readonly #log: Log;

  constructor(options: GitRepoOptions) {
    this.#reposDir = join(options.dataDir, 'repos');
    this.#worktreesDir = join(options.dataDir, 'worktrees');
    this.#secretsDir = options.secretsDir;
    this.#log = options.log ?? silentLog;
  }

  /** `data/repos/<name>.git`. */
  cloneDir(name: string): string {
    return join(this.#reposDir, `${name}.git`);
  }

  /** `data/worktrees/<name>/`. */
  worktreesDir(name: string): string {
    return join(this.#worktreesDir, name);
  }

  remoteUrl(repo: string): string {
    return remoteUrl(repo);
  }

  async ensureClone(url: string, staging: string): Promise<void> {
    const dir = this.cloneDir(staging);
    await mkdir(this.#reposDir, { recursive: true, mode: 0o700 });
    try {
      await this.#git(['clone', '--bare', '--quiet', '--', url, dir]);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw unreachable(error);
    }
    try {
      await this.#git(['--git-dir', dir, 'config', 'remote.origin.fetch', FETCH_REFSPEC]);
      await this.fetch(staging);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async fetch(name: string): Promise<void> {
    try {
      await this.#git(['--git-dir', this.cloneDir(name), 'fetch', '--quiet', '--prune', 'origin']);
    } catch (error) {
      throw unreachable(error);
    }
  }

  async mainSha(name: string): Promise<string | undefined> {
    try {
      return (await this.#git(['--git-dir', this.cloneDir(name), 'rev-parse', '--verify', '--quiet', `${MAIN_REF}^{commit}`])).trim();
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return undefined;
      throw error;
    }
  }

  async readFile(name: string, sha: string, path: string): Promise<string | undefined> {
    const dir = this.cloneDir(name);
    const listing = (await this.#git(['--git-dir', dir, 'ls-tree', sha, '--', path])).trim();
    // `<mode> <type> <object>\t<path>`; a directory or submodule at `path` is not a file.
    const [meta] = listing.split('\t');
    const [, type, object] = (meta ?? '').split(' ');
    if (type !== 'blob' || object === undefined) return undefined;
    return this.#git(['--git-dir', dir, 'cat-file', 'blob', object]);
  }

  async promote(staging: string, name: string): Promise<void> {
    const target = this.cloneDir(name);
    // Only an orphan can be here: a Project row owning this name would have been fetched, not cloned.
    if (existsSync(target)) {
      this.#log.warn({ event: 'repo_orphan_replaced', path: target }, 'repo_orphan_replaced');
      await rm(target, { recursive: true, force: true });
    }
    await rm(this.worktreesDir(name), { recursive: true, force: true });
    await rename(this.cloneDir(staging), target);
  }

  async discard(name: string): Promise<void> {
    await rm(this.cloneDir(name), { recursive: true, force: true });
    await rm(this.worktreesDir(name), { recursive: true, force: true });
  }

  async removeStaging(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.#reposDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    const stale = entries.filter((entry) => entry.startsWith(STAGING_PREFIX));
    for (const entry of stale) {
      await rm(join(this.#reposDir, entry), { recursive: true, force: true });
    }
    if (stale.length > 0) {
      this.#log.info({ event: 'repo_staging_removed', count: stale.length }, 'repo_staging_removed');
    }
    return stale.length;
  }

  async syncMain(name: string): Promise<string> {
    const dir = this.cloneDir(name);
    const sha = await this.mainSha(name);
    if (sha === undefined) {
      throw new Error(`${name} has no origin/main`);
    }
    const path = join(this.worktreesDir(name), MAIN_CHECKOUT);
    await mkdir(this.worktreesDir(name), { recursive: true, mode: 0o700 });
    await this.#git(['--git-dir', dir, 'worktree', 'prune']);
    if (!(await this.#isWorktree(name, path))) {
      await rm(path, { recursive: true, force: true });
      await this.#git(['--git-dir', dir, 'worktree', 'add', '--quiet', '--detach', '--force', path, sha]);
      return sha;
    }
    await this.#git(['-C', path, 'checkout', '--quiet', '--detach', '--force', sha]);
    await this.#git(['-C', path, 'clean', '--quiet', '-ffdx']);
    return sha;
  }

  async addTaskWorktree(name: string, taskNo: number, slug: string, baseSha: string): Promise<string> {
    const dir = this.cloneDir(name);
    const path = join(this.worktreesDir(name), String(taskNo));
    if (await this.#isWorktree(name, path)) return path;
    const branch = `antipod/${taskNo}-${slug}`;
    await mkdir(this.worktreesDir(name), { recursive: true, mode: 0o700 });
    await this.#git(['--git-dir', dir, 'worktree', 'prune']);
    const exists = await this.#git(['--git-dir', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(
      () => true,
      () => false,
    );
    await this.#git(['--git-dir', dir, 'worktree', 'add', '--quiet', ...(exists ? [path, branch] : ['-b', branch, path, baseSha])]);
    return path;
  }

  async removeTaskWorktree(name: string, taskNo: number): Promise<void> {
    const dir = this.cloneDir(name);
    const path = join(this.worktreesDir(name), String(taskNo));
    if (await this.#isWorktree(name, path)) {
      await this.#git(['--git-dir', dir, 'worktree', 'remove', '--force', '--force', path]);
    } else {
      await rm(path, { recursive: true, force: true });
    }
    await this.#git(['--git-dir', dir, 'worktree', 'prune']);
  }

  /** Whether `path` is the top of a worktree of the clone `name` (not merely inside some other repo). */
  async #isWorktree(name: string, path: string): Promise<boolean> {
    if (!existsSync(path)) return false;
    try {
      const out = await this.#git(['-C', path, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
      const [top, common] = out.trim().split('\n');
      return top !== undefined && common !== undefined && realpathSync(top) === realpathSync(path) && realpathSync(common) === realpathSync(this.cloneDir(name));
    } catch {
      return false;
    }
  }

  #git(args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', [...args], { env: gitEnv(this.#secretsDir), maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error !== null) {
          reject(new GitError(args, stderr, error.code ?? undefined));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

function unreachable(error: unknown): Error {
  if (error instanceof GitError) return new RepoUnreachableError(firstErrorLine(error.stderr), { cause: error });
  return error instanceof Error ? error : new Error(String(error));
}
