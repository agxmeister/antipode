import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureHome, resolveHome } from '../../src/app/home.ts';
import { createTempHome } from '../helpers/home.ts';

describe('home', () => {
  it('resolves ANTIPOD_HOME, defaulting to ~/.antipod', () => {
    expect(resolveHome({ ANTIPOD_HOME: '/tmp/x/../y' })).toBe('/tmp/y');
    expect(resolveHome({})).toBe(join(homedir(), '.antipod'));
    expect(resolveHome({ ANTIPOD_HOME: '' })).toBe(join(homedir(), '.antipod'));
  });

  it('creates the home, data, logs, run and secrets, all mode 700', () => {
    const root = join(createTempHome().root, 'nested', 'home');
    const paths = ensureHome(root);
    for (const dir of [root, ...['data', 'logs', 'run', 'secrets'].map((name) => join(root, name))]) {
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(paths.database).toBe(join(root, 'data', 'antipod.db'));
    expect(paths.log).toBe(join(root, 'logs', 'antipod.log'));
  });
});
