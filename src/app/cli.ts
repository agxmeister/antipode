#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDatabase } from '../adapters/sqlite/db.ts';
import { migrate } from '../adapters/sqlite/migrate.ts';
import { loadConfig } from './config.ts';
import { runDaemon } from './daemon.ts';
import { ensureHome, resolveHome } from './home.ts';
import { backup } from './ops/backup.ts';
import { spawnCommand, type CommandRunner } from './ops/command.ts';
import { plistFor } from './ops/plist.ts';
import { upgrade } from './ops/upgrade.ts';

/** The package root: two levels above this file (`dist/app/cli.js` or `src/app/cli.ts`). */
export const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

const USAGE = `Usage: antipod <command>

Commands:
  daemon    Run the Antipode daemon (under launchd)
  backup    Copy the database and data/ to backup.path
  upgrade   Pull, install, build, migrate and restart the launchd agent
  plist     Print the launchd agent plist for this instance
  migrate   Apply pending database migrations

The instance is selected by ANTIPOD_HOME (default ~/.antipod).`;

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  run: CommandRunner;
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

/** Runs one CLI invocation and resolves its exit code. */
export async function main(argv: readonly string[], deps: CliDeps = defaultDeps()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' } },
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
