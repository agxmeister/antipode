import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootDaemon } from '../../src/app/daemon.ts';
import { ensureHome, writeAntipodShim } from '../../src/app/home.ts';
import { createTempHome, readLogLines } from '../helpers/home.ts';

describe('Evidence in the daemon (AD-8, AD-18, AD-20)', () => {
  it('crash: an Evidence file with no row is deleted at boot', async () => {
    const home = createTempHome();
    const dir = join(home.root, 'data', 'evidence', 'training', '3', 'r1');
    mkdirSync(dir, { recursive: true });
    const orphan = join(dir, '01JORPHAN0000000000000000.png');
    writeFileSync(orphan, 'copied before the crash');
    const daemon = await bootDaemon({ env: home.env });
    await daemon.stop('test');
    expect(existsSync(orphan)).toBe(false);
    expect(readLogLines(readFileSync(join(home.root, 'logs', 'antipod.log'), 'utf8')).find((line) => line['event'] === 'daemon_started')).toMatchObject({ evidence_files_swept: 1 });
  });

  it('run/bin holds antipod-evidence next to antipod, both executable', () => {
    const paths = ensureHome(createTempHome().root);
    writeAntipodShim(paths);
    for (const name of ['antipod', 'antipod-evidence']) expect(statSync(join(paths.runBin, name)).mode & 0o777).toBe(0o755);
    const run = spawnSync(join(paths.runBin, 'antipod-evidence'), [], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Usage: antipod-evidence');
  });
});
