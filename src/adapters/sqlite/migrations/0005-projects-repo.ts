import type { Migration } from './index.ts';

/**
 * Project identity by repo (AD-5, AD-10): `/register` and `antipod register` find a Project by the
 * remote URL it was registered with. SQLite cannot add a UNIQUE column, so uniqueness is a unique
 * index (NULLs allowed, for Projects created before registration existed).
 */
export const migration0005: Migration = {
  id: 5,
  name: 'projects-repo',
  sql: `
    ALTER TABLE projects ADD COLUMN repo_url TEXT;
    CREATE UNIQUE INDEX projects_repo_url ON projects(repo_url);
  `,
};
