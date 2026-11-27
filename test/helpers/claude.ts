import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory holding the fake `claude` (AD-24); put it first on `PATH`. */
export const FAKE_CLAUDE_DIR = fileURLToPath(new URL('../fixtures/fake-claude', import.meta.url));
export const FAKE_CLAUDE = join(FAKE_CLAUDE_DIR, 'claude');

/** One launch of the fake, as `test/fixtures/fake-claude/claude` documents it. */
export interface FakeRun {
  text?: string;
  structured_output?: unknown;
  subtype?: string;
  result?: false;
  exit?: number;
  sleepMs?: number;
  ignoreSigint?: boolean;
  usage?: Record<string, unknown>;
  splitResult?: boolean;
  /** Recipe steps to run through `antipod step` before the result. */
  steps?: string[];
  /** Answer as the Validator in Evidence mode, one verdict per Evidence line of the brief. */
  verifyEvidence?: { verdict?: 'pass' | 'blocking' | 'nonblocking'; shows?: boolean[]; note?: string; skip?: number };
}

/** What the fake recorded about one launch. */
export interface FakeCall {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  pid: number;
}

/** The fake's state directory under an `ANTIPOD_HOME` (or any directory given as `FAKE_CLAUDE_DIR`). */
export function fakeClaudeDir(home: string): string {
  return join(home, 'fake-claude');
}

/** Sets the runs the next launches play, the last one repeating. */
export function setFakeRuns(dir: string, runs: FakeRun[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ runs }));
}

export function fakeCalls(dir: string): FakeCall[] {
  const file = join(dir, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as FakeCall);
}

/** `PATH` with the fake `claude` first. */
export function pathWithFakeClaude(path = process.env['PATH'] ?? ''): string {
  return `${FAKE_CLAUDE_DIR}:${path}`;
}

