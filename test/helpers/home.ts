import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';

export const OWNER_ID = 424242;

export interface TempHome {
  root: string;
  env: NodeJS.ProcessEnv;
  writeConfig(config: unknown): void;
  writeConfigText(text: string): void;
}

/** A fresh scratch `ANTIPOD_HOME`; writes a minimal valid `config.yaml` unless told otherwise. */
export function createTempHome(config: unknown = { owner: { telegram_user_id: OWNER_ID } }): TempHome {
  const root = mkdtempSync(join(tmpdir(), 'antipod-home-'));
  const home: TempHome = {
    root,
    env: { ...process.env, ANTIPOD_HOME: root },
    writeConfig(value) {
      writeFileSync(join(root, 'config.yaml'), stringify(value));
    },
    writeConfigText(text) {
      writeFileSync(join(root, 'config.yaml'), text);
    },
  };
  if (config !== null) {
    home.writeConfig(config);
  }
  return home;
}

/** Parses a JSON-lines log file. */
export function readLogLines(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
