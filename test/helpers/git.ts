import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** git with no global or system config, so the developer's settings never leak into tests. */
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A temporary local git remote (AD-24): a plain repo that clones and fetches like a hosted one. */
export interface TempRemote {
  /** Absolute path: used as the repo URL as given. */
  dir: string;
  /** Commits `files` on `branch` (created from the current `main` when new); returns the commit SHA. */
  commit(files: Record<string, string>, branch?: string): string;
  sha(ref: string): string;
}

export function createTempRemote(defaultBranch = 'main'): TempRemote {
  const dir = mkdtempSync(join(tmpdir(), 'antipod-remote-'));
  git(dir, 'init', '--quiet', '-b', defaultBranch);
  let first = true;
  return {
    dir,
    commit(files, branch = defaultBranch) {
      if (!first) {
        const exists = git(dir, 'branch', '--list', branch) !== '';
        git(dir, 'checkout', '--quiet', ...(exists ? [branch] : ['-b', branch]));
      }
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      git(dir, 'add', '--all');
      git(dir, 'commit', '--quiet', '--allow-empty', '-m', `commit on ${branch}`);
      first = false;
      const sha = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'checkout', '--quiet', defaultBranch);
      return sha;
    },
    sha: (ref) => git(dir, 'rev-parse', ref),
  };
}

/** A valid Recipe per the spine seed, named `name`. */
export function validRecipe(name = 'training'): string {
  return `name: ${name}
evidence_kinds: [screenshot, screencast, file]
demo: { kind: file, step: demo }
fixtures: null
steps:
  build:    { runner: container, image: ghcr.io/cirruslabs/android-sdk:34, cmd: ./gradlew assembleDebug, timeout: 15m, outputs: build/outputs }
  test:     { runner: container, image: ghcr.io/cirruslabs/android-sdk:34, cmd: ./gradlew testDebug, timeout: 15m }
  evidence: { runner: host, capability: android-emulator, exclusive: true, cmd: ./scripts/evidence.sh, timeout: 10m }
  demo:     { runner: container, image: ghcr.io/cirruslabs/android-sdk:34, cmd: ./scripts/demo.sh, timeout: 15m }
  release:  { runner: container, image: ghcr.io/cirruslabs/android-sdk:34, cmd: ./scripts/release.sh, secrets: [PROD_PLAY_KEY], timeout: 15m }
`;
}
