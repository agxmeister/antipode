import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, withContext } from '../../src/app/logger.ts';
import { createTempHome, readLogLines } from '../helpers/home.ts';

describe('logger', () => {
  it('writes JSON lines through pino-roll with logs/antipod.log linked to the current file', async () => {
    const { root } = createTempHome();
    const path = join(root, 'logs', 'antipod.log');
    const { logger, close } = await createLogger(path);
    withContext(logger, { project_id: 'p1', task_id: undefined, stage_id: 's1' }).info({ event: 'x' }, 'x');
    await close();

    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe('antipod.1.log');
    const [line] = readLogLines(readFileSync(path, 'utf8'));
    expect(line).toMatchObject({ msg: 'x', event: 'x', project_id: 'p1', stage_id: 's1' });
    expect(line).not.toHaveProperty('task_id');
  });

  it('rotates by size and moves the link to the new file', async () => {
    const { root } = createTempHome();
    const path = join(root, 'logs', 'antipod.log');
    const { logger, close } = await createLogger(path, 'info', '1k');
    for (let i = 0; i < 200 && readlinkSync(path) === 'antipod.1.log'; i++) {
      logger.info({ event: 'filler', i, pad: 'x'.repeat(100) }, 'filler');
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    }
    expect(readlinkSync(path)).toBe('antipod.2.log');
    logger.info({ event: 'after_roll' }, 'after_roll');
    await close();
    expect(readLogLines(readFileSync(path, 'utf8')).map((line) => line['event'])).toContain('after_roll');
  });
});
