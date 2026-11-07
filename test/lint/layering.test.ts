import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const depcruise = join(root, 'node_modules', '.bin', 'depcruise');
const config = join(root, '.dependency-cruiser.cjs');
const fixtures = join(root, 'test', 'fixtures', 'layering');

async function cruise(cwd: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(depcruise, ['src', '--config', config], { cwd });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('layering (AD-1)', () => {
  it.each([
    ['core-imports-pino', 'core-allowed-imports'],
    ['core-imports-type-only', 'core-allowed-imports'],
    ['core-imports-adapter', 'core-allowed-imports'],
    ['domain-imports-ports', 'domain-imports-nothing-up'],
    ['ports-import-coordinator', 'ports-import-nothing-up'],
    ['adapter-imports-adapter', 'no-adapter-to-adapter'],
    ['adapter-imports-app', 'no-adapter-to-app'],
  ])('%s fails the lint naming %s', async (fixture, rule) => {
    const result = await cruise(join(fixtures, fixture));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(`error ${rule}:`);
  });

  it('allowed imports pass', async () => {
    const result = await cruise(join(fixtures, 'clean'));
    expect(result.output).toContain('no dependency violations found');
    expect(result.code).toBe(0);
  });

  it('src/ passes', async () => {
    const result = await cruise(root);
    expect(result.output).toContain('no dependency violations found');
    expect(result.code).toBe(0);
  });
});
