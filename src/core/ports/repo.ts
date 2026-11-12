/**
 * Git as the core sees it (AD-5), implemented by `adapters/git`. Clones are addressed by name: a
 * Project's clone is `data/repos/<name>.git`, a staging clone is `data/repos/<staging>.git`.
 * Configuration is read only from `origin/main` at a recorded SHA (AD-22), never from a working tree.
 */
export interface Repo {
  /** The remote URL `repo` resolves to: `host/owner/repo` → `git@host:owner/repo.git`; anything else as given. */
  remoteUrl(repo: string): string;
  /**
   * Clones `url` bare into `staging` with refspec `+refs/heads/*:refs/remotes/origin/*` and fetches.
   * Throws `RepoUnreachableError` when the remote cannot be cloned; leaves nothing behind then.
   */
  ensureClone(url: string, staging: string): Promise<void>;
  /** Fetches `origin` into `refs/remotes/origin/*`, pruning. Throws `RepoUnreachableError`. */
  fetch(name: string): Promise<void>;
  /** The commit `origin/main` points at, or undefined when the remote has no `main`. */
  mainSha(name: string): Promise<string | undefined>;
  /** The text of `path` at commit `sha`, or undefined when no file is there. */
  readFile(name: string, sha: string, path: string): Promise<string | undefined>;
  /** Moves a staging clone to `name`, replacing an orphaned clone or worktree directory of that name. */
  promote(staging: string, name: string): Promise<void>;
  /** Deletes the clone `name` and its worktrees directory; absent ones are fine. */
  discard(name: string): Promise<void>;
  /** Deletes every staging clone left behind (`data/repos/.incoming-*`); returns how many. */
  removeStaging(): Promise<number>;
  /** Creates or fast-forwards the read-only `_main` checkout to `origin/main`; returns its SHA. */
  syncMain(name: string): Promise<string>;
  /** Adds the Task worktree on Branch `antipod/<taskNo>-<slug>` from `baseSha`; returns its path. Idempotent. */
  addTaskWorktree(name: string, taskNo: number, slug: string, baseSha: string): Promise<string>;
  /** Removes the Task worktree (its untracked files with it); the Branch is kept. */
  removeTaskWorktree(name: string, taskNo: number): Promise<void>;
}

/** Prefix of staging clone names; a crashed registration's leftover is removed at the next one. */
export const STAGING_PREFIX = '.incoming-';
