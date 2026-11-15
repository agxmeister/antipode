import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandPermissions, RoleConfigResolver, type RoleVars } from '../../../src/adapters/claude-cli/role-config.ts';
import { GitRepo } from '../../../src/adapters/git/repo.ts';
import { PACKAGE_ROLES } from '../../../src/app/home.ts';
import { RoleConfigInvalidError, UnknownRoleError } from '../../../src/core/domain/errors.ts';
import { ROLE_FILES } from '../../../src/core/domain/role.ts';
import { OUTPUT_SCHEMA_NAMES } from '../../../src/core/domain/stage-output/index.ts';
import { createTempRemote } from '../../helpers/git.ts';

const SHIPPED = ['intake', 'implementer', 'validator', 'evidence-producer', 'triage'];

function writeRole(dir: string, role: string, files: Partial<Record<string, string>>): void {
  mkdirSync(join(dir, role), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, role, file), text ?? '');
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'antipod-roles-'));
  const packageDir = join(root, 'package');
  const homeDir = join(root, 'home');
  writeRole(packageDir, 'implementer', {
    'prompt.md': 'package prompt',
    'mcp.json': '{"mcpServers":{}}',
    'permissions.json': '{"permissions":{"allow":[],"deny":["Edit(/{{WORKTREE}}/.antipod/**)"]}}',
    'role.yaml': 'output_schema: implementer\npermission_mode: dontAsk\n',
  });
  return { root, packageDir, homeDir, resolver: new RoleConfigResolver({ packageDir, homeDir }) };
}

const VARS: RoleVars = { ANTIPOD_HOME: '/h', WORKTREE: '/h/data/worktrees/p/3', ANTIPOD_PRIOR: '/h/data/prior/p/3', OTHER_WORKTREES: ['/h/data/worktrees/p/1', '/h/data/worktrees/p/_main'] };

describe('RoleConfigResolver (AD-15, AD-22)', () => {
  it('layering: home overrides prompt.md, the repo overrides permissions.json at config_sha; the rest comes from the package', async () => {
    const { root, homeDir, resolver } = setup();
    writeRole(homeDir, 'implementer', { 'prompt.md': 'home prompt' });
    const remote = createTempRemote();
    const repoPermissions = '{"permissions":{"allow":["Bash(antipod step:*)"],"deny":[]}}';
    const configSha = remote.commit({ '.antipod/roles/implementer/permissions.json': repoPermissions, 'README.md': 'x' });
    // Repo layer on Branch: a change made only on a Task Branch is never read.
    remote.commit({ '.antipod/roles/implementer/prompt.md': 'branch prompt', '.antipod/roles/implementer/role.yaml': 'output_schema: triage\n' }, 'antipod/3-x');
    const git = new GitRepo({ dataDir: join(root, 'data'), secretsDir: join(root, 'secrets') });
    await git.ensureClone(remote.dir, 'training');

    const resolved = await resolver.resolve('implementer', (path) => git.readFile('training', configSha, path));
    expect(resolved.sources).toEqual({ 'prompt.md': 'home', 'mcp.json': 'package', 'permissions.json': 'repo', 'role.yaml': 'package' });
    expect(resolved.files['prompt.md']).toBe('home prompt');
    expect(resolved.files['permissions.json']).toBe(repoPermissions);
    expect(resolved.config).toEqual({ output_schema: 'implementer', permission_mode: 'dontAsk' });

    // Without a pinned commit there is no repo layer.
    expect((await resolver.resolve('implementer')).sources['permissions.json']).toBe('package');
  });

  it('a new Role directory is usable by name; its role.yaml names a fixed output schema', async () => {
    const { homeDir, resolver } = setup();
    writeRole(homeDir, 'reviewer', {
      'prompt.md': 'p',
      'mcp.json': '{"mcpServers":{}}',
      'permissions.json': '{"permissions":{"allow":[],"deny":[]}}',
      'role.yaml': 'output_schema: triage\ntimeout: 2m\nretries: 1\nmax_turns: 9\n',
    });
    const resolved = await resolver.resolve('reviewer');
    expect(resolved.config).toEqual({ output_schema: 'triage', timeout: '2m', retries: 1, max_turns: 9, permission_mode: 'dontAsk' });
    writeRole(homeDir, 'reviewer', { 'role.yaml': 'output_schema: essay\n' });
    await expect(resolver.resolve('reviewer')).rejects.toThrow(/role\.yaml is invalid/);
  });

  it('unknown Role: no layer defines it; a name that is not a directory name is unknown too', async () => {
    const { resolver } = setup();
    await expect(resolver.resolve('nope')).rejects.toBeInstanceOf(UnknownRoleError);
    await expect(resolver.resolve('../implementer')).rejects.toBeInstanceOf(UnknownRoleError);
  });

  it('a file missing in every layer, or invalid JSON, is a RoleConfigInvalidError', async () => {
    const { homeDir, resolver } = setup();
    writeRole(homeDir, 'partial', { 'prompt.md': 'p' });
    await expect(resolver.resolve('partial')).rejects.toThrow(/mcp\.json, permissions\.json, role\.yaml found in no layer/);
    writeRole(homeDir, 'implementer', { 'permissions.json': '{not json' });
    await expect(resolver.resolve('implementer')).rejects.toBeInstanceOf(RoleConfigInvalidError);
  });

  it('materializes the four files under the Stage directory with permissions placeholders expanded', async () => {
    const { root, resolver } = setup();
    const resolved = await resolver.resolve('implementer');
    const files = await resolver.materialize(resolved, join(root, 'stages', 's1', 'role'), VARS);
    for (const file of ROLE_FILES) expect(readFileSync(join(files.dir, file), 'utf8')).not.toBe('');
    expect(JSON.parse(readFileSync(files.settingsPath, 'utf8'))).toEqual({ permissions: { allow: [], deny: ['Edit(//h/data/worktrees/p/3/.antipod/**)'] } });
    expect(readFileSync(files.systemPromptPath, 'utf8')).toBe('package prompt');
  });
});

describe('expandPermissions', () => {
  it('repeats an OTHER_WORKTREES rule per other worktree and refuses unknown placeholders', () => {
    const permissions = { permissions: { allow: ['Read(/{{ANTIPOD_PRIOR}}/**)'], deny: ['Read(/{{OTHER_WORKTREES}}/**)', 'Read(/{{ANTIPOD_HOME}}/secrets/**)'] } };
    expect(expandPermissions('r', permissions, VARS).permissions).toEqual({
      allow: ['Read(//h/data/prior/p/3/**)'],
      deny: ['Read(//h/data/worktrees/p/1/**)', 'Read(//h/data/worktrees/p/_main/**)', 'Read(//h/secrets/**)'],
    });
    expect(expandPermissions('r', permissions, { ...VARS, OTHER_WORKTREES: [] }).permissions.deny).toEqual(['Read(//h/secrets/**)']);
    expect(() => expandPermissions('r', { permissions: { allow: ['Read({{SECRET}})'], deny: [] } }, VARS)).toThrow(/unknown placeholder \{\{SECRET\}\}/);
    // A repeated rule expands its other placeholders too, and takes a path with `$&` literally.
    const mixed = { permissions: { allow: [], deny: ['Edit(/{{OTHER_WORKTREES}}/{{ANTIPOD_HOME}}.x)'] } };
    expect(expandPermissions('r', mixed, { ...VARS, OTHER_WORKTREES: ['/w/$&1'] }).permissions.deny).toEqual(['Edit(//w/$&1//h.x)']);
    const unknown = { permissions: { allow: [], deny: ['Read(/{{OTHER_WORKTREES}}/{{SECRET}})'] } };
    expect(() => expandPermissions('r', unknown, VARS)).toThrow(/unknown placeholder \{\{SECRET\}\}/);
    expect(() => expandPermissions('r', unknown, { ...VARS, OTHER_WORKTREES: [] })).toThrow(/unknown placeholder/);
  });
});

describe('shipped Roles (CAP-20)', () => {
  it('all five resolve from the package with a fixed output schema and empty MCP servers', async () => {
    const resolver = new RoleConfigResolver({ packageDir: PACKAGE_ROLES, homeDir: join(mkdtempSync(join(tmpdir(), 'antipod-roles-')), 'none') });
    for (const role of SHIPPED) {
      const resolved = await resolver.resolve(role);
      expect(Object.values(resolved.sources).every((source) => source === 'package')).toBe(true);
      expect(OUTPUT_SCHEMA_NAMES).toContain(resolved.config.output_schema);
      // config-defaults values stay in config.yaml (spec decision): role.yaml sets none of them.
      expect(resolved.config.timeout ?? resolved.config.retries ?? resolved.config.max_turns).toBeUndefined();
      expect(JSON.parse(resolved.files['mcp.json'])).toEqual({ mcpServers: {} });
    }
  });

  it('deny writes under .antipod/ and $ANTIPOD_HOME, reads of instance files and other worktrees, and direct build tools; allow antipod step', async () => {
    const resolver = new RoleConfigResolver({ packageDir: PACKAGE_ROLES, homeDir: '/nonexistent' });
    for (const role of SHIPPED) {
      const { permissions } = expandPermissions(role, (await resolver.resolve(role)).permissions, VARS);
      expect(permissions.allow).toContain('Bash(antipod step:*)');
      expect(permissions.deny).toEqual(
        expect.arrayContaining([
          'Edit(//h/data/worktrees/p/3/.antipod/**)',
          'Edit(//h/secrets/**)',
          'Edit(//h/config.yaml)',
          'Edit(//h/data/worktrees/p/1/**)',
          'Read(//h/secrets/**)',
          'Read(//h/config.yaml)',
          'Read(//h/data/antipod.db*)',
          'Read(//h/data/worktrees/p/1/**)',
          'Read(//h/data/worktrees/p/_main/**)',
          'Bash(./gradlew:*)',
          'Bash(adb:*)',
          'Bash(openscad:*)',
          'Bash(git push:*)',
        ]),
      );
      // Only the Implementer changes files in its worktree, and only it may delete or move them.
      const writes = permissions.allow.includes('Edit(//h/data/worktrees/p/3/**)');
      expect(writes).toBe(role === 'implementer');
      expect(permissions.allow.includes('Bash(git rm:*)') && permissions.allow.includes('Bash(git mv:*)')).toBe(role === 'implementer');
    }
  });
});
