import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root: two levels above this file (`dist/app/home.js` or `src/app/home.ts`). */
export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** The shipped Role directories (AD-15). */
export const PACKAGE_ROLES = join(PACKAGE_ROOT, 'roles');

export interface HomePaths {
  root: string;
  config: string;
  data: string;
  logs: string;
  run: string;
  secrets: string;
  database: string;
  log: string;
  pidFile: string;
  /** `$ANTIPOD_HOME/roles/`: Owner-level Role Config overrides (AD-15). */
  roles: string;
  /** `run/bin/`: put first on every Stage's `PATH`; holds the `antipod` shim. */
  runBin: string;
}

/** The instance directory: `ANTIPOD_HOME`, default `~/.antipod` (AD-23). */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const value = env['ANTIPOD_HOME'];
  return value !== undefined && value !== '' ? resolve(value) : join(homedir(), '.antipod');
}

export function homePaths(root: string): HomePaths {
  const data = join(root, 'data');
  const logs = join(root, 'logs');
  return {
    root,
    config: join(root, 'config.yaml'),
    data,
    logs,
    run: join(root, 'run'),
    secrets: join(root, 'secrets'),
    database: join(data, 'antipod.db'),
    log: join(logs, 'antipod.log'),
    pidFile: join(root, 'run', 'antipod.pid'),
    roles: join(root, 'roles'),
    runBin: join(root, 'run', 'bin'),
  };
}

/** Creates the home and its `data/ logs/ run/ secrets/`, all mode 700 (owner-only). */
export function ensureHome(root: string): HomePaths {
  const paths = homePaths(root);
  for (const dir of [paths.root, paths.data, paths.logs, paths.run, paths.secrets]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return paths;
}

/** Quotes `value` for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Writes `run/bin/antipod` (mode 755): runs this package's CLI with the daemon's Node, so a Stage
 * reaches `antipod step` on its `PATH` (AD-6). Rewritten at every boot; returns its path.
 */
export function writeAntipodShim(paths: HomePaths, node: string = process.execPath): string {
  const cli = fileURLToPath(new URL(`./cli${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  mkdirSync(paths.runBin, { recursive: true, mode: 0o700 });
  const shim = join(paths.runBin, 'antipod');
  const staging = `${shim}.${process.pid}`;
  writeFileSync(staging, `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(cli)} "$@"\n`, { mode: 0o755 });
  chmodSync(staging, 0o755);
  renameSync(staging, shim);
  return shim;
}
