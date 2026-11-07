import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { main, type CliDeps } from '../../../src/app/cli.ts';
import { bootDaemon } from '../../../src/app/daemon.ts';
import { spawnCommand, type CommandRunner } from '../../../src/app/ops/command.ts';
import { createTempHome, OWNER_ID } from '../../helpers/home.ts';

function deps(env: NodeJS.ProcessEnv, run: CommandRunner = spawnCommand) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliDeps = { env, out: (l) => out.push(l), err: (l) => err.push(l), run };
  return { value, out, err };
}

async function homeWithData(backupPath?: string) {
  const config: Record<string, unknown> = { owner: { telegram_user_id: OWNER_ID } };
  if (backupPath !== undefined) {
    config['backup'] = { path: backupPath };
  }
  const home = createTempHome(config);
  const daemon = await bootDaemon({ env: home.env });
  daemon.db.prepare("INSERT INTO settings VALUES ('k', 'v', '2026-11-07T00:00:00Z')").run();
  await daemon.stop('test');
  mkdirSync(join(home.root, 'data', 'evidence', 'p1'), { recursive: true });
  writeFileSync(join(home.root, 'data', 'evidence', 'p1', 'e1.png'), 'png');
  writeFileSync(join(home.root, 'data', 'antipod.db-wal'), 'stray');
  return home;
}

describe('antipod backup', () => {
  it('copies the database with VACUUM INTO and rsyncs data/ without antipod.db*', async () => {
    const target = join(createTempHome(null).root, 'backup');
    const home = await homeWithData(target);
    const cli = deps(home.env);

    expect(await main(['backup'], cli.value)).toBe(0);

    const db = new Database(join(target, 'antipod.db'), { readonly: true });
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('k')).toEqual({ value: 'v' });
    db.close();
    expect(readFileSync(join(target, 'data', 'evidence', 'p1', 'e1.png'), 'utf8')).toBe('png');
    expect(readdirSync(join(target, 'data')).filter((name) => name.startsWith('antipod.db'))).toEqual([]);
    expect(readdirSync(target).filter((name) => name.includes('.tmp'))).toEqual([]);

    // A second run replaces the copy through the temp file again.
    expect(await main(['backup'], cli.value)).toBe(0);
    expect(existsSync(join(target, 'antipod.db'))).toBe(true);
  });

  it('copies rows a running daemon has committed but not checkpointed', async () => {
    const target = join(createTempHome(null).root, 'backup');
    const home = await homeWithData(target);
    const daemon = await bootDaemon({ env: home.env });
    try {
      daemon.db.prepare("INSERT INTO settings VALUES ('live', 'w', '2026-11-07T00:00:00Z')").run();
      expect(existsSync(join(home.root, 'data', 'antipod.db-wal'))).toBe(true);
      expect(await main(['backup'], deps(home.env).value)).toBe(0);
    } finally {
      await daemon.stop('test');
    }
    const db = new Database(join(target, 'antipod.db'), { readonly: true });
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('live')).toEqual({ value: 'w' });
    db.close();
  });

  it('fails with a message when backup.path is not set', async () => {
    const home = await homeWithData();
    const cli = deps(home.env);
    expect(await main(['backup'], cli.value)).toBe(1);
    expect(cli.err.join('\n')).toContain('backup.path');
  });

  it('fails with a message when rsync fails', async () => {
    const target = join(createTempHome(null).root, 'backup');
    const home = await homeWithData(target);
    const calls: string[] = [];
    const cli = deps(home.env, async (command) => {
      calls.push(command);
      return { code: 23 };
    });
    expect(await main(['backup'], cli.value)).toBe(1);
    expect(calls).toEqual(['rsync']);
    expect(cli.err.join('\n')).toMatch(/rsync .* failed \(exit 23\)/);
  });
});
