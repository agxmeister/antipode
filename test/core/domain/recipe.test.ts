import { describe, expect, it } from 'vitest';
import { EVIDENCE_KINDS, findProdMisuse, findSecretValue, firstRecipeIssue, recipeSchema, type Recipe } from '../../../src/core/domain/recipe.ts';

function seed(): Record<string, unknown> {
  return {
    name: 'training',
    evidence_kinds: ['screenshot', 'screencast', 'file'],
    demo: { kind: 'file', step: 'demo' },
    fixtures: null,
    steps: {
      build: { runner: 'container', image: 'android:34', cmd: './gradlew assembleDebug', timeout: '15m', outputs: 'build/outputs' },
      test: { runner: 'container', image: 'android:34', cmd: './gradlew testDebug', timeout: '15m' },
      evidence: { runner: 'host', capability: 'android-emulator', exclusive: true, cmd: './scripts/evidence.sh', timeout: '10m' },
      demo: { runner: 'container', image: 'android:34', cmd: './scripts/demo.sh', timeout: '15m' },
      release: { runner: 'container', image: 'android:34', cmd: './scripts/release.sh', secrets: ['PROD_PLAY_KEY'], timeout: '15m' },
    },
  };
}

function issueOf(tree: unknown): { path: string; message: string } {
  const result = recipeSchema.safeParse(tree, { reportInput: true });
  if (result.success) throw new Error('expected a schema failure');
  const issue = firstRecipeIssue(result.error);
  return { path: issue.path.join('.'), message: issue.message };
}

function withStep(name: string, step: Record<string, unknown>): Record<string, unknown> {
  const tree = seed();
  (tree['steps'] as Record<string, unknown>)[name] = step;
  return tree;
}

describe('recipeSchema', () => {
  it('accepts the spine seed, defaults secrets and exclusive, and keeps unknown top-level keys (AD-15)', () => {
    const recipe = recipeSchema.parse({ ...seed(), limits: { iteration_budget: 3 } });
    expect(recipe.name).toBe('training');
    expect(recipe.steps['test']).toMatchObject({ secrets: [], exclusive: false });
    expect(recipe.steps['evidence']?.exclusive).toBe(true);
    expect((recipe as Recipe & { limits: unknown }).limits).toEqual({ iteration_budget: 3 });
  });

  it('allows no demo and no fixtures', () => {
    const tree = seed();
    delete tree['demo'];
    delete tree['fixtures'];
    expect(recipeSchema.parse(tree)).toMatchObject({ demo: null, fixtures: null });
  });

  it('knows every Evidence kind of AD-8', () => {
    expect(EVIDENCE_KINDS).toEqual(['screenshot', 'screencast', 'render', 'composite', 'test_result', 'measurement', 'file']);
  });

  it.each([
    ['a name with capitals', { ...seed(), name: 'Training' }, 'name', 'must be lowercase letters, digits and dashes, like training'],
    ['a missing name', { ...seed(), name: undefined }, 'name', 'is required'],
    ['no Evidence kinds', { ...seed(), evidence_kinds: [] }, 'evidence_kinds', 'must list at least one Evidence kind'],
    ['an unknown Evidence kind', { ...seed(), evidence_kinds: ['photo'] }, 'evidence_kinds.0', `must be one of ${EVIDENCE_KINDS.join(', ')}`],
    ['a demo naming no step', { ...seed(), demo: { kind: 'file', step: 'ship' } }, 'demo.step', 'must name one of the steps'],
    ['absolute fixtures', { ...seed(), fixtures: '/etc' }, 'fixtures', 'must be a path inside the repo'],
    ['fixtures leaving the repo', { ...seed(), fixtures: '../data' }, 'fixtures', 'must be a path inside the repo'],
    ['a bad timeout', withStep('test', { runner: 'container', image: 'x', cmd: 'x', timeout: '15' }), 'steps.test.timeout', 'must be a duration like 15m'],
    ['a container step without image', withStep('test', { runner: 'container', cmd: 'x', timeout: '1m' }), 'steps.test.image', 'is required for a container step'],
    ['a host step without capability', withStep('test', { runner: 'host', cmd: 'x', timeout: '1m' }), 'steps.test.capability', 'is required for a host step'],
    ['an unknown step key', withStep('test', { runner: 'host', capability: 'c', cmd: 'x', timeout: '1m', retries: 2 }), 'steps.test.retries', 'is not a known key'],
    ['an unknown runner', withStep('test', { runner: 'vm', cmd: 'x', timeout: '1m' }), 'steps.test.runner', 'must be container or host'],
    ['a bad secret name', withStep('test', { runner: 'host', capability: 'c', cmd: 'x', timeout: '1m', secrets: ['api-key'] }), 'steps.test.secrets.0', 'must be a secret name like API_TOKEN'],
    ['a step without cmd', withStep('test', { runner: 'host', capability: 'c', timeout: '1m' }), 'steps.test.cmd', 'is required'],
    ['a root that is not a mapping', 'name: x', '', 'must be a mapping'],
  ])('reports %s', (_label, tree, path, message) => {
    expect(issueOf(tree)).toEqual({ path, message });
  });
});

describe('findSecretValue', () => {
  it('finds a 16+ character string under a secret-like key, at any depth and in lists', () => {
    expect(findSecretValue({ api_token: 'abcdefghijklmnopqrst' })).toEqual(['api_token']);
    expect(findSecretValue({ x: { Password: '1234567890123456' } })).toEqual(['x', 'Password']);
    expect(findSecretValue({ credentials: ['short', 'abcdefghijklmnopqrst'] })).toEqual(['credentials', 1]);
    expect(findSecretValue({ steps: { release: { env: { AUTH_HEADER: 'Bearer abcdefghijklmnop' } } } })).toEqual(['steps', 'release', 'env', 'AUTH_HEADER']);
  });

  it('ignores short values, other keys, non-strings, and the names in a step secrets list', () => {
    expect(findSecretValue({ api_token: 'abcdefghijklmno' })).toBeUndefined();
    expect(findSecretValue({ cmd: 'abcdefghijklmnopqrstuvwxyz' })).toBeUndefined();
    expect(findSecretValue({ token: 12345678901234567890 })).toBeUndefined();
    expect(findSecretValue({ steps: { release: { secrets: ['PROD_PLAY_STORE_SERVICE_KEY'] } } })).toBeUndefined();
    expect(findSecretValue(seed())).toBeUndefined();
  });
});

describe('findProdMisuse', () => {
  it('allows PROD_ names only in the release step', () => {
    expect(findProdMisuse(recipeSchema.parse(seed()))).toBeUndefined();
    const inTest = recipeSchema.parse(withStep('test', { runner: 'host', capability: 'c', cmd: 'x', timeout: '1m', secrets: ['API', 'PROD_X'] }));
    expect(findProdMisuse(inTest)).toEqual({ name: 'PROD_X', path: ['steps', 'test', 'secrets', 1] });
    const inCmd = recipeSchema.parse(withStep('build', { runner: 'host', capability: 'c', cmd: 'deploy --key $PROD_KEY', timeout: '1m' }));
    expect(findProdMisuse(inCmd)).toEqual({ name: 'PROD_KEY', path: ['steps', 'build', 'cmd'] });
  });
});
