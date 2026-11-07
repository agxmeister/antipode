import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { main } from '../../src/app/cli.ts';
import { migrations } from '../../src/adapters/sqlite/migrations/index.ts';
import { createTempHome } from '../helpers/home.ts';

describe('antipod migrate', () => {
  it('migrates the instance database to the latest version', async () => {
    const home = createTempHome();
    const out: string[] = [];
    const code = await main(['migrate'], {
      env: home.env,
      out: (l) => out.push(l),
      err: () => {},
      run: async () => {
        throw new Error('migrate must not run commands');
      },
    });
    expect(code).toBe(0);
    expect(out).toEqual([`antipod migrate: schema version 0 → ${migrations.length}`]);
    const db = new Database(join(home.root, 'data', 'antipod.db'), { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    db.close();
  });
});
