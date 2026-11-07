import { AntipodError } from '../../core/domain/errors.ts';
import type { CommandRunner } from './command.ts';

export const LAUNCHD_LABEL = 'com.agxmeister.antipod';

export interface UpgradeStep {
  name: string;
  command: string;
  args: string[];
}

export interface UpgradeOptions {
  /** The package root (the git checkout the daemon runs from). */
  repoDir: string;
  /** `ANTIPOD_HOME` of the instance to migrate and restart. */
  home: string;
  uid: number;
  run: CommandRunner;
  /** Node binary used for the migrate step; defaults to the running one. */
  nodePath?: string;
  /** Progress line per step; defaults to stdout. */
  report?: (line: string) => void;
}

export function upgradeSteps(repoDir: string, uid: number, nodePath: string): UpgradeStep[] {
  return [
    { name: 'pull', command: 'git', args: ['pull', '--ff-only'] },
    { name: 'install', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
    { name: 'build', command: 'pnpm', args: ['build'] },
    // Runs the freshly built code, so new migrations are applied before the restart.
    { name: 'migrate', command: nodePath, args: [`${repoDir}/dist/app/cli.js`, 'migrate'] },
    { name: 'restart', command: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`] },
  ];
}

/**
 * `antipod upgrade` (AD-23): pull, install, build, migrate, `launchctl kickstart`. Stops at the
 * first failing step and names it; later steps do not run.
 */
export async function upgrade(options: UpgradeOptions): Promise<void> {
  const report = options.report ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = { ...process.env, ANTIPOD_HOME: options.home };
  for (const step of upgradeSteps(options.repoDir, options.uid, options.nodePath ?? process.execPath)) {
    report(`antipod upgrade: ${step.name}`);
    let code: number;
    try {
      ({ code } = await options.run(step.command, step.args, { cwd: options.repoDir, env }));
    } catch (error) {
      throw new AntipodError('upgrade_step_failed', `upgrade step "${step.name}" failed: ${String(error)}`, {
        cause: error,
      });
    }
    if (code !== 0) {
      throw new AntipodError('upgrade_step_failed', `upgrade step "${step.name}" failed (exit ${code})`);
    }
  }
}
