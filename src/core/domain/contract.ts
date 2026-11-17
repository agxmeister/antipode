import { z } from 'zod';
import { EVIDENCE_KINDS, type EvidenceKind } from './recipe.ts';

/** Where Owner-supplied contracts arrive on `main` (AD-5). */
export const INBOX_DIR = '.antipod/inbox';
/** Inbox files Antipode offers: a Task Contract (`.yaml`) or a BMad story (`.md`). */
export const INBOX_FILE = /\.(yaml|md)$/;
/** Where the contract projection is committed on the Branch (AD-21). */
export function contractPath(taskNo: number): string {
  return `.antipod/tasks/${taskNo}.yaml`;
}
/** The commit message of a contract projection (AD-21). */
export function contractCommitMessage(version: number): string {
  return `antipod: contract v${version}`;
}

export const CRITERION_STATUSES = ['active', 'dropped'] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

/** One row of `contracts`: one version of a Task's contract (AD-21). */
export interface ContractRow {
  task_id: string;
  version: number;
  goal: string;
  /** Task numbers of the same Project this Task waits for (CAP-15), recorded at approval. */
  depends_on: number[];
  created_at: string;
}

/** One row of `criteria`: `AC<ac_no>`, assigned once in contract order and never reused (AD-16). */
export interface CriterionRow {
  task_id: string;
  ac_no: number;
  text: string;
  required_evidence: EvidenceKind;
  /** What the Owner asked for that the Project cannot evidence; null when nothing is open. */
  infeasible_wanted: string | null;
  /** The substitute Intake proposed for `infeasible_wanted`; `Use proposal` accepts it. */
  infeasible_proposal: string | null;
  status: CriterionStatus;
}

/** One row of `draft_questions`: a clarifying question of a draft, at most two open at once (AD-9). */
export interface DraftQuestionRow {
  task_id: string;
  q_no: number;
  text: string;
  quick_answers: string[];
  answer: string | null;
}

/** One row of `contract_sources`: an inbox file imported as a draft, never offered again (AD-5). */
export interface ContractSourceRow {
  project_id: string;
  path: string;
  blob_sha: string;
  task_id: string;
  created_at: string;
}

export const INTAKE_SENDERS = ['owner', 'bot', 'inbox'] as const;
export type IntakeSender = (typeof INTAKE_SENDERS)[number];

/** One row of `intake_messages`: Owner and bot text of a Task, read into the Intake brief (AD-4). */
export interface IntakeMessageRow {
  id: string;
  task_id: string;
  sender: IntakeSender;
  text: string;
  /** The Telegram message, for an Owner message: its `👀` becomes `❌` when Intake fails (AD-10). */
  message_id: number | null;
  at: string;
}

/** A criterion is feasible when the Recipe can evidence it and it carries no open `⚠️` proposal (CAP-8). */
export function isFeasible(criterion: Pick<CriterionRow, 'required_evidence' | 'infeasible_wanted'>, evidenceKinds: readonly string[]): boolean {
  return evidenceKinds.includes(criterion.required_evidence) && criterion.infeasible_wanted === null;
}

export function activeCriteria<T extends Pick<CriterionRow, 'status'>>(criteria: readonly T[]): T[] {
  return criteria.filter((criterion) => criterion.status === 'active');
}

export function openQuestions<T extends Pick<DraftQuestionRow, 'answer'>>(questions: readonly T[]): T[] {
  return questions.filter((question) => question.answer === null);
}

/**
 * What still stands between a draft and `Approve` (`answer Q1`, `resolve AC3`), in card order; empty
 * when it may be approved. Without `evidenceKinds` only the stored `⚠️` marks count.
 */
export function openItems(criteria: readonly CriterionRow[], questions: readonly DraftQuestionRow[], evidenceKinds?: readonly string[]): string[] {
  const items = openQuestions(questions).map((question) => `answer Q${question.q_no}`);
  for (const criterion of activeCriteria(criteria)) {
    if (!isFeasible(criterion, evidenceKinds ?? [criterion.required_evidence])) items.push(`resolve AC${criterion.ac_no}`);
  }
  if (activeCriteria(criteria).length === 0) items.push('add a criterion');
  return items;
}

/** A Task title from a goal: its first line, without a trailing full stop, at most 80 characters. */
export function titleFromGoal(goal: string): string {
  const line = goal.trim().split(/\r?\n/)[0]?.trim().replace(/[.。]+$/, '') ?? '';
  const title = line === '' ? 'Untitled' : line;
  return title.length <= 80 ? title : `${title.slice(0, 79).trimEnd()}…`;
}

/** The Branch slug of a title: lowercase letters, digits and dashes, at most 40 characters (AD-5). */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug === '' ? 'task' : slug;
}

/**
 * A Task Contract file (Owner input under `.antipod/inbox/`, and the projection on the Branch).
 * `required_evidence` is any string here so an unknown kind sends the file through Intake instead of
 * failing it; `depends_on` lists Task numbers of the same Project.
 */
export const contractFileSchema = z.object({
  task: z.int().positive().optional(),
  version: z.int().positive().optional(),
  title: z.string().trim().min(1).optional(),
  goal: z.string().trim().min(1),
  criteria: z
    .array(
      z.object({
        id: z.string().optional(),
        text: z.string().trim().min(1),
        required_evidence: z.string().min(1),
        status: z.enum(CRITERION_STATUSES).optional(),
      }),
    )
    .min(1),
  depends_on: z.array(z.int().positive()).default([]),
  iteration_budget: z.int().positive().optional(),
});
export type ContractFile = z.infer<typeof contractFileSchema>;

/** Whether a parsed contract file is complete: every criterion names Evidence the Recipe declares (CAP-6). */
export function isCompleteContract(file: ContractFile, evidenceKinds: readonly string[]): boolean {
  if (!file.criteria.some((criterion) => (criterion.status ?? 'active') === 'active')) return false;
  return file.criteria.every((criterion) => (EVIDENCE_KINDS as readonly string[]).includes(criterion.required_evidence) && evidenceKinds.includes(criterion.required_evidence));
}

/** What the projection is written from: rows only (AD-21). */
export interface ContractProjection {
  task_no: number;
  version: number;
  title: string;
  goal: string;
  depends_on: readonly number[];
  criteria: readonly Pick<CriterionRow, 'ac_no' | 'text' | 'required_evidence' | 'status'>[];
}

/** A YAML double-quoted scalar: JSON string syntax is valid YAML. */
function quoted(text: string): string {
  return JSON.stringify(text);
}

/**
 * `.antipod/tasks/<task_no>.yaml` from the rows (AD-21). Deterministic, so a repeat of the same
 * version writes the same bytes; it parses back through `contractFileSchema`.
 */
export function projectContract(contract: ContractProjection): string {
  const lines = [
    '# Projection of the Antipode contract rows (spine AD-21). Antipode never reads this file.',
    `task: ${contract.task_no}`,
    `version: ${contract.version}`,
    `title: ${quoted(contract.title)}`,
    `goal: ${quoted(contract.goal)}`,
    `depends_on: [${contract.depends_on.join(', ')}]`,
    'criteria:',
  ];
  for (const criterion of [...contract.criteria].sort((a, b) => a.ac_no - b.ac_no)) {
    lines.push(
      `  - id: AC${criterion.ac_no}`,
      `    text: ${quoted(criterion.text)}`,
      `    required_evidence: ${criterion.required_evidence}`,
      `    status: ${criterion.status}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
