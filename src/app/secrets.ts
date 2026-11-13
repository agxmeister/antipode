import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Instance credentials file (AD-14): `$ANTIPOD_HOME/secrets/antipod.env`. */
export const INSTANCE_ENV = 'antipod.env';

/**
 * Parses `KEY=VALUE` lines. Blank lines and `#` comments are skipped, an optional `export ` prefix
 * is dropped, and one pair of surrounding single or double quotes is removed from the value.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2]!;
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    values[match[1]!] = value;
  }
  return values;
}

function readEnvFile(file: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return parseEnvFile(text);
}

/** Reads `secrets/antipod.env`; a missing file is no secrets. */
export function readInstanceSecrets(secretsDir: string): Record<string, string> {
  return readEnvFile(join(secretsDir, INSTANCE_ENV));
}

/** Reads the Project's secret values, `secrets/<project>.env` (AD-14); a missing file is no secrets. */
export function readProjectSecrets(secretsDir: string, project: string): Record<string, string> {
  return readEnvFile(join(secretsDir, `${project}.env`));
}
