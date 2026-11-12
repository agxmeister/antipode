import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRepo } from '../../src/adapters/git/repo.ts';
import { bootDaemon, type Daemon } from '../../src/app/daemon.ts';
import { Registration } from '../../src/app/registration.ts';
import { Coordinator } from '../../src/core/coordinator/coordinator.ts';
import { fakeClock } from '../helpers/clock.ts';
import { createTempRemote, validRecipe } from '../helpers/git.ts';
import { createTempHome } from '../helpers/home.ts';
import { openTestStore, reopenTestStore, type TestStore } from '../helpers/store.ts';
import { CHAT_ID, fakeTelegram, textUpdate } from '../helpers/telegram.ts';

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

const OTHER_CHAT = -100_999;

function harness(chatRefusal?: string | (() => Promise<string | undefined>)) {
  const ts = openTestStore();
  open.push(ts);
  const data = join(createTempHome().root, 'data');
  const coordinator = new Coordinator({
    store: ts.store,
    clock: fakeClock(),
    policy: () => ({ limits: { iteration_budget: 5, undo_accept_ms: 10_000, undo_discard_ms: 60_000 }, roles: {} }),
  });
  const registration = new Registration({
    store: ts.store,
    coordinator,
    repo: new GitRepo({ dataDir: data, secretsDir: join(data, '..', 'secrets') }),
    checkChat: typeof chatRefusal === 'function' ? chatRefusal : async () => chatRefusal,
  });
  const repos = (): string[] => (existsSync(join(data, 'repos')) ? readdirSync(join(data, 'repos')) : []);
  return { ts, data, registration, repos };
}

function remoteWith(recipe: string | undefined, branch = 'main') {
  const remote = createTempRemote(branch);
  remote.commit(recipe === undefined ? { 'README.md': 'x' } : { 'antipod.yaml': recipe });
  return remote;
}

describe('Registration', () => {
  it('happy path: binds the chat, writes repo_url, keeps the bare clone and the _main checkout', async () => {
    const h = harness();
    const remote = remoteWith(validRecipe());
    const result = await h.registration.register({ repo: remote.dir, chatId: CHAT_ID });
    expect(result).toMatchObject({ ok: true, name: 'Training', project: { name: 'training', repo_url: remote.dir, telegram_chat_id: CHAT_ID } });
    expect(h.ts.store.projectByChat(CHAT_ID)).toMatchObject({ name: 'training', repo_url: remote.dir });
    expect(h.repos()).toEqual(['training.git']);
    expect(existsSync(join(h.data, 'worktrees', 'training', '_main', 'antipod.yaml'))).toBe(true);
  });

  it('refuses without a repo argument', async () => {
    const h = harness();
    expect(await h.registration.register({ repo: ' ', chatId: CHAT_ID })).toEqual({ ok: false, reason: 'usage /register <repo>' });
  });

  it.each([['this chat is not a supergroup'], ["the bot can't read all messages here: make it an admin or turn off privacy mode"]])(
    'refuses a chat checkChat rejects: %s',
    async (reason) => {
      const h = harness(reason);
      const remote = remoteWith(validRecipe());
      expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toEqual({ ok: false, reason });
      expect(h.repos()).toEqual([]);
    },
  );

  it('refuses an unreachable repo with git\'s first error line and removes the staging clone', async () => {
    const h = harness();
    const result = await h.registration.register({ repo: join(tmpdir(), 'antipod-missing-remote'), chatId: CHAT_ID });
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^repo not reachable: fatal: .+/) });
    expect(h.repos()).toEqual([]);
    expect(h.ts.store.listProjects()).toEqual([]);
  });

  it('refuses a repo without main and removes the staging clone', async () => {
    const h = harness();
    const remote = remoteWith(validRecipe(), 'trunk');
    expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toEqual({ ok: false, reason: 'no main branch' });
    expect(h.repos()).toEqual([]);
  });

  it('refuses a repo without a Recipe', async () => {
    const h = harness();
    const remote = remoteWith(undefined);
    expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toEqual({ ok: false, reason: 'no Recipe at repo root' });
    expect(h.repos()).toEqual([]);
  });

  it('refuses a Recipe with a secret value, naming its line', async () => {
    const h = harness();
    const recipe = `${validRecipe()}\n\nnotify:\n  api_token: "${'abcd'.repeat(5)}"\n`;
    const remote = remoteWith(recipe);
    expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toEqual({ ok: false, reason: 'Recipe contains a secret value (line 14)' });
    expect(h.ts.store.projectByChat(CHAT_ID)).toBeUndefined();
  });

  it('refuses an invalid Recipe with its first issue', async () => {
    const h = harness();
    const remote = remoteWith(validRecipe().replace('testDebug, timeout: 15m', 'testDebug, timeout: soon'));
    expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toEqual({
      ok: false,
      reason: 'Recipe invalid: steps.test.timeout must be a duration like 15m (line 7)',
    });
  });

  it('refuses PROD_ outside release', async () => {
    const h = harness();
    const remote = remoteWith(validRecipe().replace('testDebug, timeout: 15m', 'testDebug, secrets: [PROD_X], timeout: 15m'));
    expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toEqual({ ok: false, reason: 'PROD_X is only allowed in the release step (line 7)' });
  });

  it('refuses a chat bound to another repo', async () => {
    const h = harness();
    expect((await h.registration.register({ repo: remoteWith(validRecipe('jumper')).dir, chatId: CHAT_ID })).ok).toBe(true);
    const result = await h.registration.register({ repo: remoteWith(validRecipe()).dir, chatId: CHAT_ID });
    expect(result).toEqual({ ok: false, reason: 'this group is already bound to Jumper' });
    expect(h.repos()).toEqual(['jumper.git']);
  });

  it('refuses a repo registered in another group', async () => {
    const h = harness();
    const remote = remoteWith(validRecipe());
    expect((await h.registration.register({ repo: remote.dir, chatId: OTHER_CHAT })).ok).toBe(true);
    expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toEqual({ ok: false, reason: 'Training is already registered in another group' });
  });

  it('refuses a Recipe name another repo already uses, and removes its staging clone', async () => {
    const h = harness();
    expect((await h.registration.register({ repo: remoteWith(validRecipe()).dir, chatId: OTHER_CHAT })).ok).toBe(true);
    expect(await h.registration.register({ repo: remoteWith(validRecipe()).dir, chatId: CHAT_ID })).toEqual({
      ok: false,
      reason: 'a Project named training already exists',
    });
    expect(h.repos()).toEqual(['training.git']);
  });

  it('re-registers the same repo in the same chat: fetches, re-validates and succeeds again', async () => {
    const h = harness();
    const remote = remoteWith(validRecipe());
    const first = await h.registration.register({ repo: remote.dir, chatId: CHAT_ID });
    const next = remote.commit({ 'antipod.yaml': validRecipe(), 'b.txt': 'b' });
    const again = await h.registration.register({ repo: remote.dir, chatId: CHAT_ID });
    expect(again).toMatchObject({ ok: true, name: 'Training', project: { id: first.ok ? first.project.id : '' } });
    expect(h.ts.store.listProjects()).toHaveLength(1);
    expect(existsSync(join(h.data, 'worktrees', 'training', '_main', 'b.txt'))).toBe(true);
    expect(next).toMatch(/^[0-9a-f]{40}$/);

    remote.commit({ 'antipod.yaml': 'name: training\n' });
    expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toEqual({ ok: false, reason: 'Recipe invalid: evidence_kinds is required (line 1)' });
    expect(h.ts.store.projectByChat(CHAT_ID)?.name).toBe('training');
  });

  it('validates the main Recipe even when another branch has an invalid one (AD-22)', async () => {
    const h = harness();
    const remote = remoteWith(validRecipe());
    remote.commit({ 'antipod.yaml': 'name: Broken\n' }, 'feature');
    expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toMatchObject({ ok: true, name: 'Training' });
  });

  it('runs two registrations started together, both succeeding', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.registration.register({ repo: remoteWith(validRecipe('a')).dir, chatId: CHAT_ID }),
      h.registration.register({ repo: remoteWith(validRecipe('b')).dir, chatId: OTHER_CHAT }),
    ]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(h.repos().sort()).toEqual(['a.git', 'b.git']);
  });

  it('resolves a refusal when checkChat throws', async () => {
    const h = harness(async () => {
      throw new Error('getMe failed: 502');
    });
    expect(await h.registration.register({ repo: remoteWith(validRecipe()).dir, chatId: CHAT_ID })).toEqual({ ok: false, reason: 'getMe failed: 502' });
  });

  it('keeps the registered name when main renames the Recipe, and refuses a rename onto another Project', async () => {
    const h = harness();
    const remote = remoteWith(validRecipe());
    expect((await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).ok).toBe(true);
    expect((await h.registration.register({ repo: remoteWith(validRecipe('jumper')).dir, chatId: OTHER_CHAT })).ok).toBe(true);
    remote.commit({ 'antipod.yaml': validRecipe('gym'), 'c.txt': 'c' });
    expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toMatchObject({ ok: true, name: 'Training', project: { name: 'training' } });
    expect(existsSync(join(h.data, 'worktrees', 'training', '_main', 'c.txt'))).toBe(true);
    remote.commit({ 'antipod.yaml': validRecipe('jumper') });
    expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toEqual({ ok: false, reason: 'a Project named jumper already exists' });
  });

  it('re-clones when the Project clone was deleted', async () => {
    const h = harness();
    const remote = remoteWith(validRecipe());
    expect((await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).ok).toBe(true);
    rmSync(join(h.data, 'repos', 'training.git'), { recursive: true, force: true });
    rmSync(join(h.data, 'worktrees'), { recursive: true, force: true });
    expect(await h.registration.register({ repo: remote.dir, chatId: CHAT_ID })).toMatchObject({ ok: true, name: 'Training' });
    expect(h.repos()).toEqual(['training.git']);
    expect(existsSync(join(h.data, 'worktrees', 'training', '_main', 'antipod.yaml'))).toBe(true);
  });

  it('removes a leftover staging clone even when the registration is refused', async () => {
    const h = harness('this chat is not a supergroup');
    mkdirSync(join(h.data, 'repos', '.incoming-01CRASHED.git'), { recursive: true });
    expect((await h.registration.register({ repo: remoteWith(validRecipe()).dir, chatId: CHAT_ID })).ok).toBe(false);
    expect(h.repos()).toEqual([]);
  });

  it('removes a staging clone left by a crashed registration', async () => {
    const h = harness();
    mkdirSync(join(h.data, 'repos', '.incoming-01CRASHED.git'), { recursive: true });
    await h.registration.register({ repo: remoteWith(undefined).dir, chatId: CHAT_ID });
    expect(h.repos()).toEqual([]);
  });
});

describe('/register through the daemon (fake Api, AD-24)', () => {
  async function boot(): Promise<{ daemon: Daemon; tg: ReturnType<typeof fakeTelegram> }> {
    const home = createTempHome();
    const tg = fakeTelegram();
    tg.respond('getChat', (payload) => ({ id: payload['chat_id'], type: 'supergroup', title: 'Antipode · Training' }));
    tg.respond('getMe', () => ({ id: 1, is_bot: true, first_name: 'Antipode', username: 'antipode_bot', can_read_all_group_messages: true }));
    const daemon = await bootDaemon({ env: home.env, telegramApi: tg.api });
    return { daemon, tg };
  }

  async function settle(daemon: Daemon): Promise<void> {
    await daemon.registration.idle();
    await daemon.messenger?.sender.idle();
  }

  async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it('binds the group and queues one silent reply', async () => {
    const { daemon, tg } = await boot();
    const remote = remoteWith(validRecipe());
    tg.pushUpdates(textUpdate(1, `/register ${remote.dir}`, { messageId: 77 }));
    await waitFor(() => daemon.store.projectByChat(CHAT_ID) !== undefined && tg.callsOf('sendMessage').length > 0);
    await settle(daemon);
    expect(daemon.store.projectByChat(CHAT_ID)).toMatchObject({ name: 'training', repo_url: remote.dir });
    const rows = daemon.store.outboxOfChat(CHAT_ID);
    expect(rows.map((r) => r.kind)).toEqual(['registration_reply']);
    expect(tg.callsOf('sendMessage')).toEqual([
      expect.objectContaining({ chat_id: CHAT_ID, text: 'Training registered', disable_notification: true, reply_parameters: { message_id: 77, allow_sending_without_reply: true } }),
    ]);
    await daemon.stop('test');
  });

  it('answers a failure loudly and leaves the group unbound', async () => {
    const { daemon, tg } = await boot();
    const remote = remoteWith(undefined);
    tg.pushUpdates(textUpdate(1, `/register ${remote.dir}`, { messageId: 78 }));
    await waitFor(() => tg.callsOf('sendMessage').length > 0);
    await settle(daemon);
    expect(daemon.store.projectByChat(CHAT_ID)).toBeUndefined();
    expect(tg.callsOf('sendMessage')).toEqual([expect.objectContaining({ text: "❌ Can't register: no Recipe at repo root", disable_notification: false })]);
    await daemon.stop('test');
  });

  it('answers /register without an argument with the usage', async () => {
    const { daemon, tg } = await boot();
    tg.pushUpdates(textUpdate(1, '/register', { messageId: 79 }));
    await waitFor(() => tg.callsOf('sendMessage').length > 0);
    expect(tg.callsOf('sendMessage')).toEqual([expect.objectContaining({ text: "❌ Can't register: usage /register &lt;repo&gt;" })]);
    await daemon.stop('test');
  });

  it('stop() waits for a registration in flight before the database closes', async () => {
    const { daemon, tg } = await boot();
    const remote = remoteWith(validRecipe());
    tg.pushUpdates(textUpdate(1, `/register ${remote.dir}`, { messageId: 80 }));
    await waitFor(() => tg.callsOf('getChat').length > 0);
    await daemon.stop('test');
    // The job finished against an open database: its row and reply are on record.
    const reopened = reopenTestStore(daemon.paths.database);
    open.push(reopened);
    expect(reopened.store.projectByChat(CHAT_ID)?.name).toBe('training');
    expect(reopened.store.outboxOfChat(CHAT_ID).map((r) => r.kind)).toEqual(['registration_reply']);
  });
});
