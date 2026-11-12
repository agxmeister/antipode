import { describe, expect, it } from 'vitest';
import { parseRecipeDocument, validateRecipeText } from '../../src/app/recipe-file.ts';
import { validRecipe } from '../helpers/git.ts';

describe('validateRecipeText', () => {
  it('accepts a valid Recipe', () => {
    const result = validateRecipeText(validRecipe());
    expect(result).toMatchObject({ ok: true, recipe: { name: 'training' } });
  });

  it('reports YAML that does not parse, with its line', () => {
    expect(validateRecipeText('name: x\nsteps: [\n')).toEqual({ ok: false, reason: expect.stringMatching(/^Recipe is not valid YAML \(line \d+\)$/) });
  });

  it('reports a secret value with the line it sits on', () => {
    const text = `${validRecipe()}\n\nnotify:\n  api_token: "${'a'.repeat(20)}"\n`;
    expect(validateRecipeText(text)).toEqual({ ok: false, reason: 'Recipe contains a secret value (line 14)' });
  });

  it('reports the first schema issue with its path and line', () => {
    const text = validRecipe().replace('cmd: ./gradlew testDebug, timeout: 15m', 'cmd: ./gradlew testDebug, timeout: 15');
    expect(validateRecipeText(text)).toEqual({ ok: false, reason: 'Recipe invalid: steps.test.timeout must be a duration like 15m (line 7)' });
  });

  it('reports a PROD_ reference outside release', () => {
    const text = validRecipe().replace('cmd: ./gradlew testDebug, timeout: 15m', 'cmd: ./gradlew testDebug, secrets: [PROD_X], timeout: 15m');
    expect(validateRecipeText(text)).toEqual({ ok: false, reason: 'PROD_X is only allowed in the release step (line 7)' });
  });

  it('checks in order: the secret scan runs before the schema', () => {
    const text = `name: Bad\ntoken: "${'x'.repeat(16)}"\n`;
    expect(validateRecipeText(text)).toEqual({ ok: false, reason: 'Recipe contains a secret value (line 2)' });
  });

  it('reports a missing key at the line of its parent', () => {
    expect(validateRecipeText('name: x\nsteps:\n  b:\n    runner: host\n    capability: c\n    timeout: 1m\nevidence_kinds: [file]\n')).toEqual({
      ok: false,
      reason: 'Recipe invalid: steps.b.cmd is required (line 3)',
    });
  });

  it('reports an empty file as not a mapping', () => {
    expect(validateRecipeText('')).toEqual({ ok: false, reason: 'Recipe invalid: Recipe must be a mapping (line 1)' });
  });
});

describe('parseRecipeDocument.lineOf', () => {
  it('finds keys of block and flow mappings and list items', () => {
    const { lineOf } = parseRecipeDocument('a: 1\nb:\n  c: [x,\n    y]\n  d: { e: 1 }\n');
    expect(lineOf([])).toBe(1);
    expect(lineOf(['b'])).toBe(2);
    expect(lineOf(['b', 'c', 1])).toBe(4);
    expect(lineOf(['b', 'd', 'e'])).toBe(5);
    expect(lineOf(['b', 'missing'])).toBe(2);
  });
});
