import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { AntipodError } from '../core/domain/errors.ts';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the one-daemon-per-home lock (AD-2): creates `file` exclusively with this pid. A file
 * naming a live process refuses with `daemon_already_running`; a stale one is replaced.
 * Returns the release function, which removes the file only while it still names this process.
 */
export function acquirePidLock(file: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const holder = readPid(file);
      if (holder !== undefined && isAlive(holder)) {
        throw new AntipodError('daemon_already_running', `another daemon (pid ${holder}) is running on this home`);
      }
      rmSync(file, { force: true });
      continue;
    }
    try {
      writeSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    return () => {
      if (readPid(file) === process.pid) {
        rmSync(file, { force: true });
      }
    };
  }
  throw new AntipodError('daemon_lock_failed', `cannot take the daemon lock ${file}`);
}
