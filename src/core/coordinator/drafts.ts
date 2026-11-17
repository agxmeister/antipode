import { activeCriteria, openItems, openQuestions, slugOf, titleFromGoal, type CriterionRow } from '../domain/contract.ts';
import type { EvidenceKind } from '../domain/recipe.ts';
import type { Task } from '../domain/task.ts';
import type { Store } from '../ports/store.ts';

/** At most this many questions of a draft are open at once (AD-9). */
export const MAX_OPEN_QUESTIONS = 2;

/** A draft contract as Intake or a contract file gives it, before AC numbers are assigned. */
export interface DraftInput {
  title?: string | undefined;
  goal: string;
  criteria: ReadonlyArray<{
    /** The number of a criterion the draft already has, to keep it (AD-16). */
    ac?: number | undefined;
    text: string;
    required_evidence: EvidenceKind;
    infeasible?: { wanted: string; proposal: string } | undefined;
  }>;
  questions: ReadonlyArray<{ text: string; quick_answers: readonly string[] }>;
  /** Task numbers this Task waits for; undefined keeps the current contract's. */
  depends_on?: readonly number[] | undefined;
}

/**
 * Writes the next version of a draft's contract (AD-21): criteria keep their `AC<n>` when Intake names
 * it (or repeats the text), new ones get the next number, and criteria left out are `dropped`, so a
 * number is never reused (AD-16). A criterion whose Evidence kind the Recipe lacks, and that Intake did
 * not flag, is marked infeasible with nothing proposed (CAP-8). Open questions are replaced; answered
 * ones stay. Synchronous: call it inside the Coordinator's transaction.
 */
export function writeDraft(store: Store, taskId: string, input: DraftInput, evidenceKinds: readonly string[], at: string): void {
  const task = store.getTask(taskId);
  if (task === undefined) throw new Error(`task ${taskId} does not exist`);
  const existing = store.criteriaOf(taskId);
  const active = new Map(activeCriteria(existing).map((criterion) => [criterion.ac_no, criterion]));
  let next = Math.max(0, ...existing.map((criterion) => criterion.ac_no)) + 1;
  const kept = new Set<number>();
  for (const criterion of input.criteria) {
    let acNo = criterion.ac !== undefined && active.has(criterion.ac) && !kept.has(criterion.ac) ? criterion.ac : undefined;
    acNo ??= [...active.values()].find((row) => !kept.has(row.ac_no) && row.text.trim() === criterion.text.trim())?.ac_no;
    acNo ??= next++;
    kept.add(acNo);
    const infeasible =
      criterion.infeasible ?? (evidenceKinds.includes(criterion.required_evidence) ? undefined : { wanted: criterion.required_evidence, proposal: null });
    store.saveCriterion({
      task_id: taskId,
      ac_no: acNo,
      text: criterion.text.trim(),
      required_evidence: criterion.required_evidence,
      infeasible_wanted: infeasible?.wanted ?? null,
      infeasible_proposal: infeasible?.proposal ?? null,
      status: 'active',
    });
  }
  for (const row of active.values()) {
    if (!kept.has(row.ac_no)) store.saveCriterion({ ...row, status: 'dropped' });
  }
  const current = store.latestContract(taskId);
  store.insertContract({
    task_id: taskId,
    version: (current?.version ?? 0) + 1,
    goal: input.goal.trim(),
    depends_on: [...(input.depends_on ?? current?.depends_on ?? [])],
    created_at: at,
  });
  store.deleteOpenQuestions(taskId);
  let qNo = Math.max(0, ...store.questionsOf(taskId).map((question) => question.q_no)) + 1;
  for (const question of input.questions.slice(0, MAX_OPEN_QUESTIONS)) {
    store.insertQuestion({ task_id: taskId, q_no: qNo++, text: question.text.trim(), quick_answers: [...question.quick_answers], answer: null });
  }
  const title = input.title?.trim() || titleFromGoal(input.goal);
  // The slug names the Branch, so it is fixed once the Task has a number (AD-5).
  store.updateTask(taskId, { title, slug: task.task_no === null ? slugOf(title) : (task.slug ?? slugOf(title)), updated_at: at });
}

/** Records `answers` on the draft's open questions, in question order. Returns how many it recorded. */
export function recordAnswers(store: Store, taskId: string, answers: readonly string[]): number {
  let recorded = 0;
  for (const [index, question] of openQuestions(store.questionsOf(taskId)).entries()) {
    const answer = answers[index]?.trim();
    if (answer === undefined || answer === '') break;
    if (store.answerQuestion(taskId, question.q_no, answer)) recorded++;
  }
  return recorded;
}

/** Inserts the next contract version with the same goal and dependencies: every criteria change bumps it (AD-21). */
export function bumpContract(store: Store, taskId: string, at: string): void {
  const current = store.latestContract(taskId);
  if (current === undefined) throw new Error(`task ${taskId} has no contract`);
  store.insertContract({ ...current, version: current.version + 1, created_at: at });
}

/** The Tasks a draft depends on, by id, or why approval must be refused (CAP-15; deferred from 1-3). */
export function resolveDependencies(store: Store, task: Task): { ids: string[] } | { refusal: string } {
  const numbers = store.latestContract(task.id)?.depends_on ?? [];
  const own = task.task_no ?? store.nextTaskNo(task.project_id);
  const ids: string[] = [];
  for (const number of numbers) {
    if (number === own) return { refusal: 'a Task cannot depend on itself' };
    const dep = store.taskByNo(task.project_id, number);
    if (dep === undefined) return { refusal: `#${number} does not exist` };
    if (dep.kind === 'bootstrap') return { refusal: `#${number} is a bootstrap Task` };
    // A cycle: the dependency, directly or through its own dependencies, waits for this Task.
    const seen = new Set<string>();
    const stack = [dep.id];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (id === task.id) return { refusal: `depending on #${number} makes a cycle` };
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...store.dependenciesOf(id).map((t) => t.id));
    }
    ids.push(dep.id);
  }
  return { ids };
}

/**
 * Why the draft cannot be approved against `evidenceKinds` (the Recipe at the approval SHA), or
 * undefined: an open question, an infeasible criterion, no criterion at all, or a bad dependency.
 */
export function approvalRefusal(store: Store, task: Task, evidenceKinds: readonly string[]): string | undefined {
  if (store.latestContract(task.id) === undefined) return 'the draft has no contract yet';
  const items = openItems(store.criteriaOf(task.id), store.questionsOf(task.id), evidenceKinds);
  if (items.length > 0) return `${items.join(' · ')} first`;
  const deps = resolveDependencies(store, task);
  return 'refusal' in deps ? deps.refusal : undefined;
}

/** The criteria shown on the card and in briefs, `AC<n>` order. */
export function sortedCriteria(criteria: readonly CriterionRow[]): CriterionRow[] {
  return [...criteria].sort((a, b) => a.ac_no - b.ac_no);
}
