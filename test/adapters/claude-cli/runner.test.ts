import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { claudeArgs, ClaudeCliRunner, outcomeOf, usageOf } from '../../../src/adapters/claude-cli/runner.ts';
import { implementerOutputSchema, validatorOutputSchema } from '../../../src/core/domain/stage-output/index.ts';
import type { AgentRunSpec } from '../../../src/core/ports/agent-runner.ts';
import { systemClock } from '../../../src/app/clock.ts';
import { FAKE_CLAUDE, fakeCalls, setFakeRuns, type FakeRun } from '../../helpers/claude.ts';

const DONE = { status: 'done', summary: 'changed the button' };

function setup(runs: FakeRun[], overrides: Partial<AgentRunSpec> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'antipod-claude-'));
  const fake = join(root, 'fake');
  setFakeRuns(fake, runs);
  const cwd = join(root, 'worktree');
  mkdirSync(cwd);
  const role = join(root, 'role');
  mkdirSync(role);
  for (const file of ['permissions.json', 'mcp.json', 'prompt.md']) writeFileSync(join(role, file), '{}');
  const spec: AgentRunSpec = {
    stageId: 'stage-1',
    cwd,
    prompt: 'the brief',
    transcriptPath: join(root, 'data', 'stages', 'stage-1.jsonl'),
    outputSchema: implementerOutputSchema,
    settingsPath: join(role, 'permissions.json'),
    mcpConfigPath: join(role, 'mcp.json'),
    systemPromptPath: join(role, 'prompt.md'),
    permissionMode: 'dontAsk',
    maxTurns: 150,
    timeoutMs: 10_000,
    auth: 'subscription',
    env: { PATH: process.env['PATH'] ?? '', FAKE_CLAUDE_DIR: fake },
    ...overrides,
  };
  return { root, fake, spec };
}

describe('claudeArgs', () => {
  it('is exactly the AD-4 flag set (amended 2026-11-15); api-key mode adds --bare', () => {
    const { spec } = setup([{}]);
    const schema = JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { status: { type: 'string', enum: ['done', 'blocked'] }, summary: { type: 'string', minLength: 1 } },
      required: ['status', 'summary'],
      additionalProperties: false,
    });
    const expected = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', schema,
      '--permission-prompts', 'none',
      '--settings', spec.settingsPath,
      '--setting-sources', '',
      '--strict-mcp-config',
      '--mcp-config', spec.mcpConfigPath,
      '--permission-mode', 'dontAsk',
      '--append-system-prompt-file', spec.systemPromptPath,
      '--max-turns', '150',
    ];
    expect(claudeArgs(spec)).toEqual(expected);
    expect(claudeArgs({ ...spec, auth: 'api-key' })).toEqual([...expected, '--bare']);
  });
});

describe('usageOf and outcomeOf', () => {
  it('reads tokens, cost and duration from a result message; missing fields are null', () => {
    expect(usageOf({ usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.1, duration_ms: 9 })).toEqual({
      input_tokens: 3,
      output_tokens: 4,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      cost_usd: 0.1,
      duration_ms: 9,
    });
  });

  it('maps an error result, a missing structured_output and structured-output retries', () => {
    const spec = { outputSchema: implementerOutputSchema };
    const end = { timedOut: false, exitCode: 1, signal: null, stderr: '' };
    expect(outcomeOf(spec, { ...end, result: { subtype: 'error_during_execution', is_error: true } })).toMatchObject({ outcome: 'failed', reason: 'exit' });
    expect(outcomeOf(spec, { ...end, exitCode: 0, result: { subtype: 'success' } })).toMatchObject({ outcome: 'failed', reason: 'invalid_output' });
    expect(outcomeOf(spec, { ...end, result: { subtype: 'error_max_structured_output_retries' } })).toMatchObject({ outcome: 'failed', reason: 'invalid_output' });
  });

  it('judges a result that arrived before the deadline even when the process lingered past it; timeout only without one', () => {
    const spec = { outputSchema: implementerOutputSchema };
    const end = { timedOut: true, exitCode: null, signal: 'SIGTERM', stderr: '' };
    const result = { subtype: 'success', structured_output: { status: 'done', summary: 's' }, duration_ms: 5 };
    expect(outcomeOf(spec, { ...end, result })).toMatchObject({ outcome: 'output', output: { status: 'done', summary: 's' }, usage: { duration_ms: 5 } });
    expect(outcomeOf(spec, { ...end, result: undefined })).toMatchObject({ outcome: 'failed', reason: 'timeout', usage: null });
  });

  it('a Validator verdict that disagrees with its findings fails invalid_output', () => {
    const spec = { outputSchema: validatorOutputSchema };
    const end = { timedOut: false, exitCode: 0, signal: null, stderr: '' };
    const blocker = { criterion_id: 'AC1', blocking: true, note: 'broken' };
    const minor = { criterion_id: 'AC2', blocking: false, note: 'nit' };
    const judge = (structured_output: unknown) => outcomeOf(spec, { ...end, result: { subtype: 'success', structured_output } });
    expect(judge({ verdict: 'pass', findings: [blocker] })).toMatchObject({ outcome: 'failed', reason: 'invalid_output' });
    expect(judge({ verdict: 'nonblocking', findings: [minor, blocker] })).toMatchObject({ outcome: 'failed', reason: 'invalid_output' });
    expect(judge({ verdict: 'blocking', findings: [minor] })).toMatchObject({ outcome: 'failed', reason: 'invalid_output' });
    expect(judge({ verdict: 'blocking', findings: [blocker] })).toMatchObject({ outcome: 'output' });
    expect(judge({ verdict: 'nonblocking', findings: [minor] })).toMatchObject({ outcome: 'output' });
    expect(judge({ verdict: 'pass', findings: [] })).toMatchObject({ outcome: 'output' });
  });
});

describe('ClaudeCliRunner (fake claude, AD-24)', () => {
  it('typed output: runs in the worktree with only the given env, the brief on stdin, the stream appended to the transcript', async () => {
    const { fake, spec } = setup([{ structured_output: DONE, text: 'all done' }]);
    const runner = new ClaudeCliRunner({ claude: FAKE_CLAUDE, clock: systemClock });
    let started = 0;
    const result = await runner.run({ ...spec, onStarted: () => started++ });
    expect(result).toEqual({
      outcome: 'output',
      output: DONE,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, cost_usd: 0.42, duration_ms: 1234 },
    });
    expect(started).toBe(1);
    const [call] = fakeCalls(fake);
    expect(call?.argv).toEqual(claudeArgs(spec));
    expect(call?.stdin).toBe('the brief');
    expect(call?.cwd.endsWith('/worktree')).toBe(true);
    const env = { ...call?.env };
    delete env['__CF_USER_TEXT_ENCODING'];
    expect(Object.keys(env).sort()).toEqual(['FAKE_CLAUDE_DIR', 'PATH']);
    const transcript = readFileSync(spec.transcriptPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    expect(transcript.map((message) => message.type)).toEqual(['system', 'assistant', 'result']);
    expect(runner.observe('stage-1')).toBeUndefined();
  });

  it('a multi-byte character split across two stdout chunks survives intact', async () => {
    const summary = 'Привет, мир — ✓ 🚀'.repeat(50);
    const { spec } = setup([{ structured_output: { status: 'done', summary }, splitResult: true }]);
    const result = await new ClaudeCliRunner({ claude: FAKE_CLAUDE, clock: systemClock }).run(spec);
    expect(result).toMatchObject({ outcome: 'output', output: { status: 'done', summary } });
  });

  it('a synchronous throw while launching is a rejected promise, not a throw', async () => {
    const { root, spec } = setup([{}]);
    writeFileSync(join(root, 'file'), 'x');
    const run = new ClaudeCliRunner({ claude: FAKE_CLAUDE, clock: systemClock }).run({ ...spec, transcriptPath: join(root, 'file', 'sub', 't.jsonl') });
    await expect(run).rejects.toThrow(/ENOTDIR|EEXIST/);
  });

  it('an unwritable transcript is logged and the Stage still ends with its result', async () => {
    const { root, spec } = setup([{ structured_output: DONE }]);
    mkdirSync(join(root, 'dir.jsonl'));
    const errors: string[] = [];
    const log = { debug() {}, info() {}, warn() {}, error: (fields: Record<string, unknown>) => errors.push(String(fields['event'])) };
    const result = await new ClaudeCliRunner({ claude: FAKE_CLAUDE, clock: systemClock, log }).run({ ...spec, transcriptPath: join(root, 'dir.jsonl') });
    expect(result).toMatchObject({ outcome: 'output', output: DONE });
    expect(errors).toContain('stage_transcript_error');
  });

  it('appends a second attempt to an existing transcript', async () => {
    const { spec } = setup([{ structured_output: DONE }]);
    const runner = new ClaudeCliRunner({ claude: FAKE_CLAUDE, clock: systemClock });
    await runner.run(spec);
    await runner.run(spec);
    expect(readFileSync(spec.transcriptPath, 'utf8').trim().split('\n')).toHaveLength(6);
  });

  it('invalid output: output that fails the zod schema fails invalid_output, with usage', async () => {
    const { spec } = setup([{ structured_output: { status: 'finished' } }]);
    const result = await new ClaudeCliRunner({ claude: FAKE_CLAUDE, clock: systemClock }).run(spec);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'invalid_output', usage: { input_tokens: 100 } });
  });

  it('max turns: a result with subtype error_max_turns fails max_turns', async () => {
    const { spec } = setup([{ subtype: 'error_max_turns', exit: 1 }]);
    const result = await new ClaudeCliRunner({ claude: FAKE_CLAUDE, clock: systemClock }).run(spec);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'max_turns' });
  });

  it('crash: a non-zero exit with no result fails exit, usage null', async () => {
    const { spec } = setup([{ result: false, exit: 3 }]);
    const result = await new ClaudeCliRunner({ claude: FAKE_CLAUDE, clock: systemClock }).run(spec);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'exit', usage: null });
    expect(result.outcome === 'failed' && result.detail).toMatch(/exit code 3/);
  });

  it('timeout: SIGINT at the deadline, SIGTERM after the grace; fails timeout with usage null', async () => {
    const { spec } = setup([{ structured_output: DONE, sleepMs: 20_000, ignoreSigint: true }], { timeoutMs: 300 });
    const runner = new ClaudeCliRunner({ claude: FAKE_CLAUDE, clock: systemClock, killGraceMs: 400 });
    const started = Date.now();
    const result = await runner.run(spec);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'timeout', usage: null });
    // It outlived the SIGINT it ignored and ended only on the SIGTERM after the grace.
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('abort: stops a running Stage with SIGINT; observe reports it while it runs', async () => {
    const { spec } = setup([{ structured_output: DONE, sleepMs: 20_000, text: 'thinking hard' }]);
    const runner = new ClaudeCliRunner({ claude: FAKE_CLAUDE, clock: systemClock });
    const controller = new AbortController();
    const running = runner.run(spec, controller.signal);
    await vi.waitFor(() => expect(runner.observe('stage-1')?.last_text).toBe('thinking hard'));
    expect(runner.observe('stage-1')?.elapsed_ms).toBeGreaterThanOrEqual(0);
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ outcome: 'failed', reason: 'exit', usage: null });
    expect(runner.observe('stage-1')).toBeUndefined();
  });

  it('launch throws: a claude that does not exist rejects and starts nothing', async () => {
    const { spec } = setup([{}]);
    let started = 0;
    await expect(new ClaudeCliRunner({ claude: '/nonexistent/claude', clock: systemClock }).run({ ...spec, onStarted: () => started++ })).rejects.toThrow(/ENOENT/);
    expect(started).toBe(0);
  });
});
