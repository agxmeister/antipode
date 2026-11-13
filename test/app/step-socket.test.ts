import { statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/app/cli.ts';
import { SOCKET_FILE, startStepSocket, type StepSocket } from '../../src/app/step-socket.ts';
import { ulid } from '../../src/core/domain/ids.ts';
import { recipeWith, stepsHarness, type StepsHarness } from '../helpers/steps.ts';

let open: StepsHarness[] = [];
let sockets: StepSocket[] = [];
afterEach(async () => {
  for (const s of sockets) await s.close();
  for (const h of open) h.close();
  open = [];
  sockets = [];
});

const RECIPE = recipeWith(
  [
    '  build: { runner: host, capability: echoer, cmd: "echo building; exit 0", timeout: 1m }',
    '  failing: { runner: host, capability: echoer, cmd: "exit 3", timeout: 1m }',
    '  slow: { runner: host, capability: echoer, cmd: "sleep 30", timeout: 1s }',
    '  hang: { runner: host, capability: echoer, cmd: "sleep 30", timeout: 1m }',
    '  evidence: { runner: host, capability: echoer, exclusive: true, cmd: "true", timeout: 1m }',
  ].join('\n'),
);

async function setup(): Promise<StepsHarness & { socketPath: string; cli(step: string, stageId?: string | null): Promise<{ code: number; out: string[]; err: string[] }> }> {
  const h = stepsHarness({ recipe: RECIPE });
  open.push(h);
  const socketPath = join(h.paths.run, SOCKET_FILE);
  sockets.push(await startStepSocket({ path: socketPath, steps: h.steps }));
  const cli = async (step: string, stageId: string | null = h.stage.id) => {
    const out: string[] = [];
    const err: string[] = [];
    const env: NodeJS.ProcessEnv = { ANTIPOD_HOME: h.paths.root, ...(stageId === null ? {} : { ANTIPOD_STAGE_ID: stageId }) };
    const code = await main(['step', step], { env, out: (l) => out.push(l), err: (l) => err.push(l), run: async () => ({ code: 0 }) });
    return { code, out, err };
  };
  return { ...h, socketPath, cli };
}

describe('step socket and antipod step (AD-6)', () => {
  it('Client: prints the log and out paths and exits with the step’s code; the socket is mode 600', async () => {
    const h = await setup();
    expect(statSync(h.socketPath).mode & 0o777).toBe(0o600);
    const ok = await h.cli('build');
    expect(ok.code).toBe(0);
    const [run] = h.store.stepRunsInStatus(['finished']);
    const dir = join(h.paths.data, 'steps', run!.id);
    expect(ok.out).toEqual([`log: ${join(dir, 'log')}`, `out: ${join(dir, 'out')}`]);
    expect(run).toMatchObject({ stage_id: h.stage.id, step: 'build', exit_code: 0 });

    expect((await h.cli('failing')).code).toBe(3);
  });

  it('Client: timeout exits 124', async () => {
    const h = await setup();
    const result = await h.cli('slow');
    expect(result.code).toBe(124);
    expect(result.out[0]).toMatch(/^log: /);
  });

  it('Client: capability_busy exits 75', async () => {
    const h = await setup();
    const other = h.addTask();
    const holder = ulid();
    h.store.insertStepRun({ id: holder, task_id: other.task.id, stage_id: null, step: 'evidence', runner: 'host', status: 'running', outcome: null, exit_code: null, reason: null, started_at: '2026-11-08T12:00:00.000Z', ended_at: null });
    h.store.acquireLease({ capability: 'echoer', task_id: other.task.id, step_run_id: holder, acquired_at: '2026-11-08T12:00:00.000Z' });
    expect((await h.cli('evidence')).code).toBe(75);
  });

  it('Unknown step and Stale Stage: refused with the reason, exit 2', async () => {
    const h = await setup();
    expect(await h.cli('nope')).toEqual({ code: 2, out: [], err: ['antipod step: no step nope in the Recipe'] });
    expect(await h.cli('build', 'not-a-stage')).toEqual({ code: 2, out: [], err: ['antipod step: stage is not running'] });
  });

  it('without ANTIPOD_STAGE_ID, or with no daemon listening, exits 2', async () => {
    const h = await setup();
    expect((await h.cli('build', null)).code).toBe(2);
    await sockets.pop()!.close();
    expect(await h.cli('build')).toEqual({ code: 2, out: [], err: ['antipod step: daemon not running'] });
  });

  it('a malformed request is refused', async () => {
    const h = await setup();
    const answer = await new Promise<string>((resolve) => {
      let text = '';
      const socket = createConnection(h.socketPath, () => socket.write('{"step": 1}\n'));
      socket.on('data', (chunk) => (text += String(chunk)));
      socket.on('close', () => resolve(text));
    });
    expect(JSON.parse(answer)).toEqual({ refused: 'bad request' });
  });

  it('a dropped client connection stops its step', async () => {
    const h = await setup();
    const socket = createConnection(h.socketPath, () => socket.write(`${JSON.stringify({ stage_id: h.stage.id, step: 'hang' })}\n`));
    const started = Date.now();
    while (h.store.stepRunsInStatus(['running']).length === 0) {
      if (Date.now() - started > 5000) throw new Error('step never started');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    socket.destroy();
    while (h.store.stepRunsInStatus(['failed']).length === 0) {
      if (Date.now() - started > 8000) throw new Error('step never stopped');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(h.store.stepRunsInStatus(['failed'])).toMatchObject([{ step: 'hang', reason: 'aborted' }]);
  });

  it('close() aborts steps in flight and waits for them', async () => {
    const h = await setup();
    const pending = h.cli('hang');
    const started = Date.now();
    while (h.store.stepRunsInStatus(['running']).length === 0) {
      if (Date.now() - started > 5000) throw new Error('step never started');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await sockets.pop()!.close();
    expect(h.store.stepRunsInStatus(['running'])).toEqual([]);
    expect(h.store.stepRunsInStatus(['failed'])).toMatchObject([{ reason: 'aborted' }]);
    expect(await pending).toEqual({ code: 2, out: [], err: ['antipod step: step hang was stopped'] });
  });
});
