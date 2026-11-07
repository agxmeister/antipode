declare module 'pino-roll' {
  import type { EventEmitter } from 'node:events';

  export interface PinoRollOptions {
    file: string | (() => string);
    size?: string | number;
    frequency?: string | number;
    extension?: string;
    symlink?: boolean;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
    dateFormat?: string;
    mkdir?: boolean;
    sync?: boolean;
  }

  /** The SonicBoom stream pino-roll returns; only the members Antipode uses. */
  export interface RollStream extends EventEmitter {
    /** Current file path; `null` until the first open completes. */
    readonly file: string | null;
    write(data: string): boolean;
    flushSync(): void;
    end(): void;
  }

  export default function pinoRoll(options: PinoRollOptions): Promise<RollStream>;
}
