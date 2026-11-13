#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Api } from 'grammy';
import { GitRepo } from '../adapters/git/repo.ts';
import { openDatabase } from '../adapters/sqlite/db.ts';
import { migrate } from '../adapters/sqlite/migrate.ts';
import { SqliteStore } from '../adapters/sqlite/store.ts';
import { checkChat } from '../adapters/telegram/messenger.ts';
import { Coordinator } from '../core/coordinator/coordinator.ts';
import { systemClock } from './clock.ts';
import { loadConfig } from './config.ts';
import { runDaemon } from './daemon.ts';
import { ensureHome, resolveHome } from './home.ts';
import { backup } from './ops/backup.ts';
import { spawnCommand, type CommandRunner } from './ops/command.ts';
import { plistFor } from './ops/plist.ts';
import { upgrade } from './ops/upgrade.ts';
import { Registration } from './registration.ts';
import { readInstanceSecrets } from './secrets.ts';
import { EXIT_REFUSED, requestStep, SOCKET_FILE } from './step-socket.ts';

/** The package root: two levels above this file (`dist/app/cli.js` or `src/app/cli.ts`). */
export const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

const USAGE = `Usage: antipod <command>

Commands:
  daemon    Run the Antipode daemon (under launchd)
  backup    Copy the database and data/ to backup.path
  upgrade   Pull, install, build, migrate and restart the launchd agent
  plist     Print the launchd agent plist for this instance
  migrate   Apply pending database migrations
  register <repo> --chat-id <id>
            Register a repo and bind it to a Telegram supergroup (fallback for /register)
  step <name>
            Run a Recipe step through the daemon, from inside a Stage (ANTIPOD_STAGE_ID)

The instance is selected by ANTIPOD_HOME (default ~/.antipod).`;

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  run: CommandRunner;
  /** The Bot API used to check the chat on `register`; built from `TELEGRAM_BOT_TOKEN` when absent. Tests pass a fake (AD-24). */
  telegramApi?: Api;
}

const defaultDeps = (): CliDeps => ({
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  run: spawnCommand,
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `--chat-id -100123` → `--chat-id=-100123`: supergroup ids are negative, and parseArgs reads a leading dash as an option. */
function joinNegativeChatId(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--chat-id' && next !== undefined && /^-\d+$/.test(next)) {
      out.push(`--chat-id=${next}`);
      i += 1;
    } else {
      out.push(argv[i]!);
    }
  }
  return out;
}

/** Runs one CLI invocation and resolves its exit code. */
export async function main(argv: readonly string[], deps: CliDeps = defaultDeps()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: joinNegativeChatId(argv),
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' }, 'chat-id': { type: 'string' } },
    });
  } catch (error) {
    deps.err(`antipod: ${message(error)}`);
    deps.err(USAGE);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  if (parsed.values.help === true || command === undefined || command === 'help') {
    deps.out(USAGE);
    return command === undefined && parsed.values.help !== true ? 2 : 0;
  }
  const chatIdOption = parsed.values['chat-id'];
  if (command === 'register') {
    const chatId = chatIdOption === undefined || !/^-?\d+$/.test(chatIdOption) ? Number.NaN : Number(chatIdOption);
    if (rest.length !== 1 || !Number.isSafeInteger(chatId)) {
      deps.err('Usage: antipod register <repo> --chat-id <id>');
      return 2;
    }
    return registerCommand(rest[0]!, chatId, deps);
  }
  if (command === 'step' && chatIdOption === undefined) {
    if (rest.length !== 1) {
      deps.err('Usage: antipod step <name>');
      return EXIT_REFUSED;
    }
    return stepCommand(rest[0]!, deps);
  }
  if (chatIdOption !== undefined) {
    deps.err(`antipod ${command}: unexpected option --chat-id`);
    return 2;
  }
  if (rest.length > 0) {
    deps.err(`antipod ${command}: unexpected arguments: ${rest.join(' ')}`);
    return 2;
  }

  const home = resolveHome(deps.env);
  try {
    switch (command) {
      case 'daemon':
        return await runDaemon({ env: deps.env, report: deps.err });
      case 'backup': {
        const paths = ensureHome(home);
        const result = await backup({ paths, config: loadConfig(paths.config), run: deps.run });
        deps.out(`antipod backup: database → ${result.database}, data → ${result.data}`);
        return 0;
      }
      case 'upgrade': {
        const uid = process.getuid?.();
        if (uid === undefined) {
          deps.err('antipod upgrade: launchd user id unavailable on this platform');
          return 1;
        }
        await upgrade({ repoDir: packageRoot, home, uid, run: deps.run, report: deps.out });
        deps.out('antipod upgrade: done');
        return 0;
      }
      case 'plist':
        deps.out(
          plistFor(packageRoot, {
            nodePath: process.execPath,
            cliPath: join(packageRoot, 'dist', 'app', 'cli.js'),
            home,
            path: deps.env['PATH'] ?? '',
          }),
        );
        return 0;
      case 'migrate': {
        const paths = ensureHome(home);
        const db = openDatabase(paths.database);
        try {
          const result = migrate(db);
          deps.out(`antipod migrate: schema version ${result.from} → ${result.to}`);
        } finally {
          db.close();
        }
        return 0;
      }
      default:
        deps.err(`antipod: unknown command "${command}"`);
        deps.err(USAGE);
        return 2;
    }
  } catch (error) {
    deps.err(`antipod ${command}: ${message(error)}`);
    return 1;
  }
}

/**
 * `antipod register <repo> --chat-id <id>`: the same registration as `/register` (AD-10), writing the
 * rows itself, so it works with or without the daemon running. The result goes to stdout; nothing is
 * sent to the group.
 */
async function registerCommand(repo: string, chatId: number, deps: CliDeps): Promise<number> {
  try {
    const paths = ensureHome(resolveHome(deps.env));
    const config = loadConfig(paths.config);
    const api = deps.telegramApi ?? apiFromSecrets(paths.secrets);
    if (api === undefined) {
      deps.err('antipod register: no TELEGRAM_BOT_TOKEN in secrets/antipod.env, so the chat cannot be checked');
      return 1;
    }
    const db = openDatabase(paths.database);
    try {
      migrate(db);
      const store = new SqliteStore(db);
      const coordinator = new Coordinator({ store, clock: systemClock, policy: () => ({ limits: config.limits, roles: config.roles }) });
      const registration = new Registration({
        store,
        coordinator,
        repo: new GitRepo({ dataDir: paths.data, secretsDir: paths.secrets }),
        checkChat: (id) => checkChat(api, id),
      });
      const result = await registration.register({ repo, chatId });
      if (result.ok) {
        deps.out(`antipod register: ${result.name} registered`);
        return 0;
      }
      deps.out(`antipod register: Can't register: ${result.reason}`);
      return 1;
    } finally {
      db.close();
    }
  } catch (error) {
    deps.err(`antipod register: ${message(error)}`);
    return 1;
  }
}

/**
 * `antipod step <name>` (AD-6): asks the daemon of `ANTIPOD_HOME` to run the step for the Stage in
 * `ANTIPOD_STAGE_ID`, prints the log and out paths and exits with the step's code.
 */
async function stepCommand(name: string, deps: CliDeps): Promise<number> {
  const stageId = deps.env['ANTIPOD_STAGE_ID'];
  if (stageId === undefined || stageId === '') {
    deps.err('antipod step: ANTIPOD_STAGE_ID is not set; run it from inside a Stage');
    return EXIT_REFUSED;
  }
  const result = await requestStep(join(resolveHome(deps.env), 'run', SOCKET_FILE), { stage_id: stageId, step: name });
  for (const line of result.out) deps.out(line);
  for (const line of result.err) deps.err(`antipod step: ${line}`);
  return result.code;
}

function apiFromSecrets(secretsDir: string): Api | undefined {
  const token = readInstanceSecrets(secretsDir)['TELEGRAM_BOT_TOKEN'];
  return token === undefined || token === '' ? undefined : new Api(token);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
