import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  contractFileSchema,
  isCompleteContract,
  isFeasible,
  openItems,
  projectContract,
  slugOf,
  titleFromGoal,
  type CriterionRow,
  type DraftQuestionRow,
} from '../../../src/core/domain/contract.ts';
import { ownerInstructionSchema } from '../../../src/core/domain/stage-output/index.ts';

function criterion(acNo: number, overrides: Partial<CriterionRow> = {}): CriterionRow {
  return { task_id: 't', ac_no: acNo, text: `criterion ${acNo}`, required_evidence: 'screenshot', infeasible_wanted: null, infeasible_proposal: null, status: 'active', ...overrides };
}

function question(qNo: number, answer: string | null = null): DraftQuestionRow {
  return { task_id: 't', q_no: qNo, text: `question ${qNo}`, quick_answers: [], answer };
}

describe('contract domain (AD-16, AD-21, CAP-8)', () => {
  it('feasible means a declared kind and no open ⚠️', () => {
    expect(isFeasible(criterion(1), ['screenshot'])).toBe(true);
    expect(isFeasible(criterion(1), ['file'])).toBe(false);
    expect(isFeasible(criterion(1, { infeasible_wanted: 'haptics' }), ['screenshot'])).toBe(false);
  });

  it('openItems lists open questions, then unresolved criteria; dropped criteria do not count', () => {
    const criteria = [criterion(1), criterion(2, { infeasible_wanted: 'haptics' }), criterion(3, { status: 'dropped', infeasible_wanted: 'x' })];
    expect(openItems(criteria, [question(1), question(2, 'Yes')])).toEqual(['answer Q1', 'resolve AC2']);
    expect(openItems([criterion(1)], [], ['file'])).toEqual(['resolve AC1']);
    expect(openItems([criterion(1, { status: 'dropped' })], [])).toEqual(['add a criterion']);
    expect(openItems([criterion(1)], [question(1, 'No')])).toEqual([]);
  });

  it('titles and slugs', () => {
    expect(titleFromGoal('Add a rest timer after each set.\nMore detail')).toBe('Add a rest timer after each set');
    expect(titleFromGoal('x'.repeat(100))).toHaveLength(80);
    expect(slugOf('Rest timer — after each set!')).toBe('rest-timer-after-each-set');
    expect(slugOf('Café über alles')).toBe('cafe-uber-alles');
    expect(slugOf('日本語')).toBe('task');
    expect(slugOf('a'.repeat(60)).length).toBeLessThanOrEqual(40);
  });

  it('the projection is deterministic YAML that parses back as a contract file with the same rows', () => {
    const projection = {
      task_no: 12,
      version: 3,
      title: 'Rest "timer": after: each set',
      goal: 'Line one\nline two: with # hash',
      depends_on: [4, 7],
      criteria: [criterion(2, { status: 'dropped' }), criterion(1, { text: "it's: 90 s", required_evidence: 'screencast' })],
    };
    const yaml = projectContract(projection);
    expect(projectContract(projection)).toBe(yaml);
    const parsed = contractFileSchema.parse(parseYaml(yaml));
    expect(parsed).toEqual({
      task: 12,
      version: 3,
      title: projection.title,
      goal: projection.goal,
      depends_on: [4, 7],
      criteria: [
        { id: 'AC1', text: "it's: 90 s", required_evidence: 'screencast', status: 'active' },
        { id: 'AC2', text: 'criterion 2', required_evidence: 'screenshot', status: 'dropped' },
      ],
    });
  });

  it('a contract file is complete only when every criterion names a kind the Recipe declares', () => {
    const file = contractFileSchema.parse({ goal: 'g', criteria: [{ text: 'a', required_evidence: 'screenshot' }, { text: 'b', required_evidence: 'haptics' }] });
    expect(file.depends_on).toEqual([]);
    expect(isCompleteContract(file, ['screenshot'])).toBe(false);
    expect(isCompleteContract({ ...file, criteria: [file.criteria[0]!] }, ['screenshot'])).toBe(true);
    expect(isCompleteContract({ ...file, criteria: [file.criteria[0]!] }, ['file'])).toBe(false);
    expect(contractFileSchema.safeParse({ goal: 'g', criteria: [] }).success).toBe(false);
    const allDropped = contractFileSchema.parse({ goal: 'g', criteria: [{ text: 'a', required_evidence: 'screenshot', status: 'dropped' }] });
    expect(isCompleteContract(allDropped, ['screenshot'])).toBe(false);
  });

  it('OwnerInstruction new_draft takes Evidence kinds only, optional infeasible, questions as text or with quick answers', () => {
    const ok = ownerInstructionSchema.safeParse({
      instructions: [
        {
          kind: 'new_draft',
          goal: 'g',
          criteria: [{ text: 'a', required_evidence: 'file', infeasible: { wanted: 'haptics', proposal: 'log' } }],
          questions: ['plain?', { text: 'closed?', quick_answers: ['Yes', 'No'] }],
        },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = ownerInstructionSchema.safeParse({ instructions: [{ kind: 'new_draft', goal: 'g', criteria: [{ text: 'a', required_evidence: 'haptics' }], questions: [] }] });
    expect(bad.success).toBe(false);
  });
});
