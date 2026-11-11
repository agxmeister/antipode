import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnvFile, readInstanceSecrets } from '../../src/app/secrets.ts';

describe('secrets', () => {
  it('parses KEY=VALUE lines, skipping comments and blanks, unquoting values', () => {
    const text = ['# comment', '', 'TELEGRAM_BOT_TOKEN=123:abc', 'export QUOTED="a b"', "SINGLE='x=y'", 'not a line', ''].join('\n');
    expect(parseEnvFile(text)).toEqual({ TELEGRAM_BOT_TOKEN: '123:abc', QUOTED: 'a b', SINGLE: 'x=y' });
  });

  it('reads secrets/antipod.env; a missing file is no secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antipod-secrets-'));
    expect(readInstanceSecrets(dir)).toEqual({});
    writeFileSync(join(dir, 'antipod.env'), 'TELEGRAM_BOT_TOKEN=fake\n');
    expect(readInstanceSecrets(dir)).toEqual({ TELEGRAM_BOT_TOKEN: 'fake' });
  });
});
