import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface HomePaths {
  root: string;
  config: string;
  data: string;
  logs: string;
  run: string;
  secrets: string;
  database: string;
  log: string;
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
  };
}

/** Creates `data/ logs/ run/ secrets/` under the home; `secrets/` is mode 700. */
export function ensureHome(root: string): HomePaths {
  const paths = homePaths(root);
  for (const dir of [paths.data, paths.logs, paths.run]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(paths.secrets, { recursive: true, mode: 0o700 });
  chmodSync(paths.secrets, 0o700);
  return paths;
}
