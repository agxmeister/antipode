import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { main } from '../../src/app/cli.ts';
import { migrations } from '../../src/adapters/sqlite/migrations/index.ts';
import { createTempRemote, validRecipe } from '../helpers/git.ts';
import { createTempHome } from '../helpers/home.ts';
import { CHAT_ID, fakeTelegram } from '../helpers/telegram.ts';

describe('antipod migrate', () => {
  it('migrates the instance database to the latest version', async () => {
    const home = createTempHome();
    const out: string[] = [];
    const code = await main(['migrate'], {
      env: home.env,
      out: (l) => out.push(l),
      err: () => {},
      run: async () => {
        throw new Error('migrate must not run commands');
      },
    });
    expect(code).toBe(0);
    expect(out).toEqual([`antipod migrate: schema version 0 → ${migrations.length}`]);
    const db = new Database(join(home.root, 'data', 'antipod.db'), { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    db.close();
  });
});

describe('antipod register (CLI fallback, AD-10)', () => {
  function deps(home: ReturnType<typeof createTempHome>, tg = fakeTelegram()) {
    tg.respond('getChat', (payload) => ({ id: payload['chat_id'], type: 'supergroup', title: 'Antipode · Training' }));
    tg.respond('getMe', () => ({ id: 1, is_bot: true, first_name: 'Antipode', username: 'antipode_bot', can_read_all_group_messages: true }));
    const out: string[] = [];
    const err: string[] = [];
    return {
      tg,
      out,
      err,
      deps: {
        env: home.env,
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        run: async () => {
          throw new Error('register must not run commands');
        },
        telegramApi: tg.api,
      },
    };
  }

  it('registers with a negative chat id, writes the rows, prints the result and sends nothing to the group', async () => {
    const home = createTempHome();
    const remote = createTempRemote();
    remote.commit({ 'antipod.yaml': validRecipe() });
    const d = deps(home);
    expect(await main(['register', remote.dir, '--chat-id', String(CHAT_ID)], d.deps)).toBe(0);
    expect(d.out).toEqual(['antipod register: Training registered']);
    expect(d.tg.callsOf('sendMessage')).toEqual([]);
    expect(d.tg.callsOf('getChat')).toEqual([{ chat_id: CHAT_ID }]);
    const db = new Database(join(home.root, 'data', 'antipod.db'), { readonly: true });
    expect(db.prepare('SELECT name, repo_url, telegram_chat_id FROM projects').all()).toEqual([{ name: 'training', repo_url: remote.dir, telegram_chat_id: CHAT_ID }]);
    db.close();
  });

  it('prints the refusal and exits 1', async () => {
    const home = createTempHome();
    const remote = createTempRemote();
    remote.commit({ 'README.md': 'x' });
    const d = deps(home);
    expect(await main(['register', remote.dir, `--chat-id=${CHAT_ID}`], d.deps)).toBe(1);
    expect(d.out).toEqual(["antipod register: Can't register: no Recipe at repo root"]);
  });

  it('needs a repo and a numeric --chat-id', async () => {
    const home = createTempHome();
    const d = deps(home);
    expect(await main(['register', '/tmp/x'], d.deps)).toBe(2);
    expect(await main(['register', '--chat-id', '5'], d.deps)).toBe(2);
    expect(await main(['register', '/tmp/x', '--chat-id', 'abc'], d.deps)).toBe(2);
    expect(await main(['migrate', '--chat-id', '5'], d.deps)).toBe(2);
    expect(d.err.filter((l) => l.startsWith('Usage: antipod register'))).toHaveLength(3);
  });

  it('refuses without a bot token, since the chat cannot be checked', async () => {
    const home = createTempHome();
    const d = deps(home);
    const { telegramApi: _unused, ...withoutApi } = d.deps;
    expect(await main(['register', '/tmp/x', '--chat-id', '5'], withoutApi)).toBe(1);
    expect(d.err).toEqual(['antipod register: no TELEGRAM_BOT_TOKEN in secrets/antipod.env, so the chat cannot be checked']);
  });
});
