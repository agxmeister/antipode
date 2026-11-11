import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTempHome, readLogLines } from '../helpers/home.ts';

const cli = fileURLToPath(new URL('../../src/app/cli.ts', import.meta.url));

describe('daemon process', () => {
  it('exits 0 on SIGTERM and logs daemon_started and daemon_stopped as JSON lines', async () => {
    const home = createTempHome();
    const log = join(home.root, 'logs', 'antipod.log');
    const child = spawn(process.execPath, [cli, 'daemon'], { env: home.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)));

    const started = (): boolean => existsSync(log) && readFileSync(log, 'utf8').includes('daemon_started');
    for (let i = 0; i < 300 && !started() && child.exitCode === null; i++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    expect(started(), stderr).toBe(true);

    child.kill('SIGHUP');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    child.kill('SIGTERM');
    expect(await exited, stderr).toBe(0);

    const lines = readLogLines(readFileSync(log, 'utf8'));
    expect(lines.map((line) => line['msg'])).toEqual(['telegram_disabled', 'daemon_started', 'config_reloaded', 'daemon_stopped']);
    expect(lines.at(-1)).toMatchObject({ event: 'daemon_stopped', reason: 'SIGTERM' });
  });
});
