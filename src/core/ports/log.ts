/**
 * Structured logging as the core sees it: one line per event, fields first (spine Logging
 * convention). `app/` passes its pino logger, which satisfies this shape.
 */
export interface Log {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export const silentLog: Log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
