import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FETCH_REFSPEC, firstErrorLine, GitRepo, gitEnv, remoteUrl } from '../../../src/adapters/git/repo.ts';
import { RepoUnreachableError } from '../../../src/core/domain/errors.ts';
import { createTempRemote, git, validRecipe } from '../../helpers/git.ts';

function setup(): { repo: GitRepo; data: string; secrets: string } {
  const root = mkdtempSync(join(tmpdir(), 'antipod-git-'));
  const data = join(root, 'data');
  const secrets = join(root, 'secrets');
  mkdirSync(secrets);
  return { repo: new GitRepo({ dataDir: data, secretsDir: secrets }), data, secrets };
}

describe('remoteUrl', () => {
  it('turns host/owner/repo into an SSH URL and leaves schemes, git@ and absolute paths alone', () => {
    expect(remoteUrl('github.com/agxmeister/training')).toBe('git@github.com:agxmeister/training.git');
    expect(remoteUrl('github.com/agxmeister/training.git')).toBe('git@github.com:agxmeister/training.git');
    expect(remoteUrl('https://github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(remoteUrl('ssh://git@host/a/b')).toBe('ssh://git@host/a/b');
    expect(remoteUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
    expect(remoteUrl('/tmp/remote')).toBe('/tmp/remote');
  });
});

describe('gitEnv', () => {
  it('disables prompts and sets GIT_SSH_COMMAND only when secrets/id_antipod exists (AD-14)', () => {
    const { secrets } = setup();
    const without = gitEnv(secrets, { PATH: '/bin', GIT_SSH_COMMAND: 'ssh -i elsewhere' });
    expect(without['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(without['GIT_SSH_COMMAND']).toBeUndefined();
    writeFileSync(join(secrets, 'id_antipod'), 'key', { mode: 0o600 });
    expect(gitEnv(secrets, { PATH: '/bin' })['GIT_SSH_COMMAND']).toBe(`ssh -i '${join(secrets, 'id_antipod')}' -o IdentitiesOnly=yes -o BatchMode=yes`);
  });
});

describe('firstErrorLine', () => {
  it('skips progress lines and prefers fatal/error lines', () => {
    expect(firstErrorLine("Cloning into bare repository 'x'...\nfatal: repository '/nope' does not exist\n")).toBe("fatal: repository '/nope' does not exist");
    expect(firstErrorLine('')).toBe('git failed');
  });
});

describe('GitRepo (temporary local remote, AD-24)', () => {
  it('clones bare with the origin refspec, and reads the Recipe at origin/main', async () => {
    const remote = createTempRemote();
    const sha = remote.commit({ 'antipod.yaml': validRecipe() });
    const { repo, data } = setup();
    await repo.ensureClone(remote.dir, '.incoming-1');
    const dir = join(data, 'repos', '.incoming-1.git');
    expect(git(dir, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(git(dir, 'config', '--get', 'remote.origin.fetch')).toBe(FETCH_REFSPEC);
    expect(() => git(dir, 'config', '--get', 'remote.origin.mirror')).toThrow();
    expect(await repo.mainSha('.incoming-1')).toBe(sha);
    expect(await repo.readFile('.incoming-1', sha, 'antipod.yaml')).toBe(validRecipe());
    expect(await repo.readFile('.incoming-1', sha, 'missing.yaml')).toBeUndefined();
  });

  it('reads main, not another branch or the remote HEAD', async () => {
    const remote = createTempRemote();
    const main = remote.commit({ 'antipod.yaml': validRecipe() });
    remote.commit({ 'antipod.yaml': 'name: Broken\n' }, 'feature');
    git(remote.dir, 'checkout', '--quiet', 'feature');
    const { repo } = setup();
    await repo.ensureClone(remote.dir, 'p');
    expect(await repo.mainSha('p')).toBe(main);
    expect(await repo.readFile('p', main, 'antipod.yaml')).toBe(validRecipe());
  });

  it('fetches new commits through the refspec', async () => {
    const remote = createTempRemote();
    remote.commit({ 'antipod.yaml': validRecipe() });
    const { repo } = setup();
    await repo.ensureClone(remote.dir, 'p');
    const next = remote.commit({ 'antipod.yaml': validRecipe('renamed') });
    const other = remote.commit({ 'x.txt': 'x' }, 'topic');
    await repo.fetch('p');
    expect(await repo.mainSha('p')).toBe(next);
    expect(await repo.readFile('p', next, 'antipod.yaml')).toBe(validRecipe('renamed'));
    expect(await repo.readFile('p', other, 'x.txt')).toBe('x');
  });

  it('reports no main as undefined', async () => {
    const remote = createTempRemote('trunk');
    remote.commit({ 'antipod.yaml': validRecipe() });
    const { repo } = setup();
    await repo.ensureClone(remote.dir, 'p');
    expect(await repo.mainSha('p')).toBeUndefined();
  });

  it('throws RepoUnreachableError with git\'s first error line and leaves nothing behind', async () => {
    const { repo, data } = setup();
    const missing = join(tmpdir(), 'antipod-no-such-remote');
    const error = await repo.ensureClone(missing, '.incoming-2').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoUnreachableError);
    expect((error as Error).message).toMatch(/^repo not reachable: fatal: /);
    expect(existsSync(join(data, 'repos', '.incoming-2.git'))).toBe(false);
  });

  it('promotes a staging clone, discards clones, and removes leftover staging clones', async () => {
    const remote = createTempRemote();
    remote.commit({ 'antipod.yaml': validRecipe() });
    const { repo, data } = setup();
    await repo.ensureClone(remote.dir, '.incoming-a');
    await repo.ensureClone(remote.dir, '.incoming-b');
    await repo.promote('.incoming-a', 'training');
    expect(existsSync(join(data, 'repos', 'training.git'))).toBe(true);
    expect(await repo.removeStaging()).toBe(1);
    expect(existsSync(join(data, 'repos', '.incoming-b.git'))).toBe(false);
    await repo.discard('training');
    expect(existsSync(join(data, 'repos', 'training.git'))).toBe(false);
  });

  it('creates the _main checkout and fast-forwards it', async () => {
    const remote = createTempRemote();
    const first = remote.commit({ 'antipod.yaml': validRecipe(), 'a.txt': '1' });
    const { repo, data } = setup();
    await repo.ensureClone(remote.dir, 'p');
    expect(await repo.syncMain('p')).toBe(first);
    const main = join(data, 'worktrees', 'p', '_main');
    expect(readFileSync(join(main, 'a.txt'), 'utf8')).toBe('1');
    writeFileSync(join(main, 'stray.txt'), 'x');
    const second = remote.commit({ 'a.txt': '2' });
    await repo.fetch('p');
    expect(await repo.syncMain('p')).toBe(second);
    expect(readFileSync(join(main, 'a.txt'), 'utf8')).toBe('2');
    expect(existsSync(join(main, 'stray.txt'))).toBe(false);
    expect(git(main, 'rev-parse', 'HEAD')).toBe(second);
  });

  it('adds a Task worktree on its Branch, idempotently, and removes it keeping the Branch', async () => {
    const remote = createTempRemote();
    const base = remote.commit({ 'antipod.yaml': validRecipe() });
    const { repo, data } = setup();
    await repo.ensureClone(remote.dir, 'p');
    const path = await repo.addTaskWorktree('p', 12, 'rest-timer', base);
    expect(path).toBe(join(data, 'worktrees', 'p', '12'));
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('antipod/12-rest-timer');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(base);
    expect(await repo.addTaskWorktree('p', 12, 'rest-timer', base)).toBe(path);
    mkdirSync(join(path, '.antipod-data'));
    writeFileSync(join(path, '.antipod-data', 'seed'), 'x');
    await repo.removeTaskWorktree('p', 12);
    expect(existsSync(path)).toBe(false);
    const clone = join(data, 'repos', 'p.git');
    expect(git(clone, 'rev-parse', 'refs/heads/antipod/12-rest-timer')).toBe(base);
    // Re-adding after removal checks the kept Branch out again.
    expect(await repo.addTaskWorktree('p', 12, 'rest-timer', base)).toBe(path);
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('antipod/12-rest-timer');
  });
});
