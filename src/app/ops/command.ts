import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs an external command to completion. Injected so ops can be tested without git, pnpm or launchctl. */
export type CommandRunner = (command: string, args: readonly string[], options?: CommandOptions) => Promise<CommandResult>;

/** Spawns the command with inherited stdio so its output reaches the operator's terminal. */
export const spawnCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code: code ?? (signal !== null ? 128 : 1) }));
  });
