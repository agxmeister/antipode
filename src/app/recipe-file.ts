import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, type Document } from 'yaml';
import { findProdMisuse, findSecretValue, firstRecipeIssue, recipeSchema, type Recipe, type RecipePath } from '../core/domain/recipe.ts';

export type RecipeValidation = { ok: true; recipe: Recipe } | { ok: false; reason: string };

/** A parsed Recipe document that can say on which line a value of the tree sits. */
export interface RecipeDocument {
  document: Document;
  /** The 1-based line of the key (or list item) at `path`; the nearest existing ancestor when it is absent. */
  lineOf(path: RecipePath): number;
}

/** Parses Recipe text keeping positions; YAML errors are left on `document.errors`. */
export function parseRecipeDocument(text: string): RecipeDocument {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, prettyErrors: true });
  const line = (offset: number | undefined): number => (offset === undefined ? 1 : lineCounter.linePos(offset).line);

  function lineOf(path: RecipePath): number {
    let node: unknown = document.contents;
    let at = line((document.contents as { range?: [number, number, number] } | null)?.range?.[0]);
    for (const part of path) {
      if (isMap(node)) {
        const pair = node.items.find((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === String(part));
        if (pair === undefined) return at;
        at = line((pair.key as { range?: [number, number, number] }).range?.[0]);
        node = pair.value;
      } else if (isSeq(node) && typeof part === 'number') {
        const item = node.items[part] as { range?: [number, number, number] } | undefined;
        if (item === undefined) return at;
        at = line(item.range?.[0]);
        node = item;
      } else {
        return at;
      }
    }
    return at;
  }

  return { document, lineOf };
}

function pathText(path: RecipePath): string {
  return path.map(String).join('.');
}

/**
 * Validates Recipe text in AD-14's order: YAML parses → no secret value → schema → no `PROD_` outside
 * `release`. The first failure is the reason, with its line in the YAML document.
 */
export function validateRecipeText(text: string): RecipeValidation {
  const { document, lineOf } = parseRecipeDocument(text);
  const yamlError = document.errors[0];
  if (yamlError !== undefined) {
    const line = yamlError.linePos?.[0]?.line;
    return { ok: false, reason: `Recipe is not valid YAML${line === undefined ? '' : ` (line ${line})`}` };
  }
  const tree: unknown = document.toJS();

  const secret = findSecretValue(tree);
  if (secret !== undefined) {
    return { ok: false, reason: `Recipe contains a secret value (line ${lineOf(secret)})` };
  }

  const parsed = recipeSchema.safeParse(tree, { reportInput: true });
  if (!parsed.success) {
    const issue = firstRecipeIssue(parsed.error);
    const subject = issue.path.length === 0 ? 'Recipe' : pathText(issue.path);
    return { ok: false, reason: `Recipe invalid: ${subject} ${issue.message} (line ${lineOf(issue.path)})` };
  }

  const prod = findProdMisuse(parsed.data);
  if (prod !== undefined) {
    return { ok: false, reason: `${prod.name} is only allowed in the release step (line ${lineOf(prod.path)})` };
  }
  return { ok: true, recipe: parsed.data };
}
