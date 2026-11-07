import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../../src/app/config.ts';
import { ConfigInvalidError } from '../../src/core/domain/errors.ts';
import { createTempHome, OWNER_ID } from '../helpers/home.ts';

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigInvalidError);
    return (error as ConfigInvalidError).issues.map((issue) => issue.path);
  }
  throw new Error('expected ConfigInvalidError');
}

describe('config', () => {
  it('resolves every config-defaults.md key when only the owner id is set', () => {
    const home = createTempHome();
    expect(loadConfig(join(home.root, 'config.yaml'))).toEqual({
      owner: { telegram_user_id: OWNER_ID },
      agent: { auth: 'subscription' },
      limits: {
        iteration_budget: 5,
        concurrency: 2,
        open_reviews: 3,
        undo_accept_ms: 10_000,
        undo_discard_ms: 60_000,
      },
      usage: { pause_at_percent: 85, poll_interval_ms: 60_000 },
      intake: { retries: 2, context_messages: 10 },
      outbox: { retries: 5 },
      telegram: { stale_after_ms: 300_000 },
      backup: {},
      capabilities: {},
      logging: { level: 'info' },
    });
  });

  it('keeps explicit values', () => {
    const config = parseConfig({
      owner: { telegram_user_id: 7 },
      agent: { auth: 'api-key' },
      limits: { concurrency: 3 },
      backup: { path: '/Volumes/backup/antipod' },
      capabilities: { openscad: '/opt/homebrew/bin/openscad' },
      logging: { level: 'debug' },
    });
    expect(config.agent.auth).toBe('api-key');
    expect(config.limits).toMatchObject({ concurrency: 3, iteration_budget: 5 });
    expect(config.backup.path).toBe('/Volumes/backup/antipod');
    expect(config.capabilities).toEqual({ openscad: '/opt/homebrew/bin/openscad' });
    expect(config.logging.level).toBe('debug');
  });

  it('names owner.telegram_user_id when the owner id is missing', () => {
    expect(issuesOf(() => parseConfig({}))).toEqual(['owner.telegram_user_id']);
    expect(issuesOf(() => parseConfig({ owner: {} }))).toEqual(['owner.telegram_user_id']);
    expect(issuesOf(() => parseConfig(null))).toEqual(['owner.telegram_user_id']);
  });

  it('names limits.concurrency when it is out of range', () => {
    const error = (() => {
      try {
        parseConfig({ owner: { telegram_user_id: 1 }, limits: { concurrency: 4 } });
      } catch (caught) {
        return caught as ConfigInvalidError;
      }
      throw new Error('expected ConfigInvalidError');
    })();
    expect(error.issues.map((issue) => issue.path)).toEqual(['limits.concurrency']);
    expect(error.message).toContain('limits.concurrency');
  });

  it('rejects unknown keys and bad enum values by path', () => {
    expect(
      issuesOf(() => parseConfig({ owner: { telegram_user_id: 1 }, limit: {}, agent: { auth: 'oauth' } })).sort(),
    ).toEqual(['agent.auth', 'limit']);
  });

  it('requires backup.path to be absolute', () => {
    const error = (() => {
      try {
        parseConfig({ owner: { telegram_user_id: 1 }, backup: { path: '~/backups' } });
      } catch (caught) {
        return caught as ConfigInvalidError;
      }
      throw new Error('expected ConfigInvalidError');
    })();
    expect(error.issues).toEqual([{ path: 'backup.path', message: 'must be an absolute path' }]);
    expect(issuesOf(() => parseConfig({ owner: { telegram_user_id: 1 }, backup: { path: 'rel/dir' } }))).toEqual([
      'backup.path',
    ]);
  });

  it('reports unparseable YAML and a missing file', () => {
    const home = createTempHome(null);
    expect(issuesOf(() => loadConfig(join(home.root, 'config.yaml')))).toEqual(['(file)']);
    expect(() => loadConfig(join(home.root, 'config.yaml'))).toThrow('cannot read config file (ENOENT)');
    home.writeConfigText('owner: [\n');
    expect(issuesOf(() => loadConfig(join(home.root, 'config.yaml')))).toEqual(['(yaml)']);
  });
});
