/** Base class of every typed Antipode error. `code` is a stable snake_case identifier. */
export class AntipodError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export interface ConfigIssue {
  /** Dotted key path inside `config.yaml`, e.g. `limits.concurrency`. */
  path: string;
  message: string;
}

/** `config.yaml` is missing, unparseable or fails the schema. */
export class ConfigInvalidError extends AntipodError {
  readonly file: string;
  readonly issues: readonly ConfigIssue[];

  constructor(file: string, issues: readonly ConfigIssue[], options?: { cause?: unknown }) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    super('config_invalid', `invalid config ${file}: ${detail}`, options);
    this.file = file;
    this.issues = issues;
  }
}

/** The database `user_version` is above the highest migration this code knows. */
export class DatabaseNewerThanCodeError extends AntipodError {
  readonly databaseVersion: number;
  readonly codeVersion: number;

  constructor(databaseVersion: number, codeVersion: number) {
    super(
      'database_newer_than_code',
      `database schema version ${databaseVersion} is newer than this code supports (${codeVersion}); upgrade Antipode`,
    );
    this.databaseVersion = databaseVersion;
    this.codeVersion = codeVersion;
  }
}
