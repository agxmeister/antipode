import { describe, expect, it } from 'vitest';
import { main, packageRoot } from '../../../src/app/cli.ts';
import type { CommandRunner } from '../../../src/app/ops/command.ts';
import { upgrade } from '../../../src/app/ops/upgrade.ts';
import { AntipodError } from '../../../src/core/domain/errors.ts';
import { createTempHome } from '../../helpers/home.ts';

interface Call {
  command: string;
  args: readonly string[];
  cwd: string | undefined;
  home: string | undefined;
}

function recorder(failOn?: string): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd, home: options?.env?.['ANTIPOD_HOME'] });
    return { code: failOn !== undefined && args.includes(failOn) ? 1 : 0 };
  };
  return { run, calls };
}

describe('antipod upgrade', () => {
  it('pulls, installs, builds, migrates and kickstarts in order', async () => {
    const { run, calls } = recorder();
    await upgrade({ repoDir: '/repo', home: '/home/x', uid: 501, run, nodePath: '/bin/node', report: () => {} });
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ['git', 'pull', '--ff-only'],
      ['pnpm', 'install', '--frozen-lockfile'],
      ['pnpm', 'build'],
      ['/bin/node', '/repo/dist/app/cli.js', 'migrate'],
      ['launchctl', 'kickstart', '-k', 'gui/501/com.agxmeister.antipod'],
    ]);
    expect(calls.every((call) => call.cwd === '/repo' && call.home === '/home/x')).toBe(true);
  });

  it('stops at the failing step and names it', async () => {
    const { run, calls } = recorder('build');
    const failure = upgrade({ repoDir: '/repo', home: '/home/x', uid: 501, run, report: () => {} });
    await expect(failure).rejects.toThrow(AntipodError);
    await expect(failure).rejects.toThrow('upgrade step "build" failed (exit 1)');
    expect(calls.map((call) => call.args[0])).toEqual(['pull', 'install', 'build']);
  });

  it('exits 1 from the CLI when a step fails, running from the package root', async () => {
    const home = createTempHome();
    const { run, calls } = recorder('--ff-only');
    const err: string[] = [];
    const code = await main(['upgrade'], { env: home.env, out: () => {}, err: (l) => err.push(l), run });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('"pull"');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(packageRoot);
    expect(calls[0]?.home).toBe(home.root);
  });
});
