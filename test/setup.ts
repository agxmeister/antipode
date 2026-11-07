import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// AD-24 guard: refuse to run any test against the Owner's real instance.
const configured = process.env['ANTIPOD_HOME'];
if (configured === undefined || configured === '') {
  throw new Error('ANTIPOD_HOME must point at a scratch directory when running tests');
}
const canonical = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));
if (canonical(configured) === canonical(join(homedir(), '.antipod'))) {
  throw new Error(`ANTIPOD_HOME resolves to the Owner's instance (${configured}); tests refuse to run`);
}
