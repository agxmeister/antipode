import { parse as parseYaml } from 'yaml';
import { ANSWER, APPROVE, DISCARD, DRAFT_CARD, DROP, UNDO, USE_PROPOSAL } from '../adapters/telegram/cards/draft-card.ts';
import type { CallbackCommand, InboundMessage } from '../adapters/telegram/poller.ts';
import type { Coordinator } from '../core/coordinator/coordinator.ts';
import { MAX_OPEN_QUESTIONS, recordAnswers, writeDraft, type DraftInput } from '../core/coordinator/drafts.ts';
import {
  activeCriteria,
  contractCommitMessage,
  contractFileSchema,
  contractPath,
  INBOX_DIR,
  INBOX_FILE,
  isCompleteContract,
  projectContract,
  slugOf,
  titleFromGoal,
  type IntakeMessageRow,
} from '../core/domain/contract.ts';
import type { EffectOf } from '../core/domain/effects.ts';
import type { Event } from '../core/domain/events.ts';
import { ulid } from '../core/domain/ids.ts';
import { EVIDENCE_KINDS, RECIPE_FILE, type EvidenceKind } from '../core/domain/recipe.ts';
import { ownerInstructionSchema, type DraftQuestion } from '../core/domain/stage-output/index.ts';
import { TERMINAL_STATES, type Project, type Task } from '../core/domain/task.ts';
import type { Clock } from '../core/ports/clock.ts';
import { silentLog, type Log } from '../core/ports/log.ts';
import type { Repo } from '../core/ports/repo.ts';
import type { Store } from '../core/ports/store.ts';
import { validateRecipeText } from './recipe-file.ts';
import type { HookResult, OutputHook } from './stages.ts';

/** Toasts of the Draft card buttons (EXPERIENCE: every tap is acknowledged; `Queued.` per Flow 1). */
export const TOAST = {
  answered: 'Answered.',
  proposal: 'Proposal used.',
  dropped: (acNo: number) => `Dropped AC${acNo}.`,
  queued: 'Queued.',
  discarded: 'Discarded.',
  restored: 'Restored.',
  noRecipe: "Can't approve: the Recipe on main can't be read.",
} as const;

export interface IntakeOptions {
  store: Store;
  coordinator: Pick<Coordinator, 'applyEvent' | 'createTask' | 'approveDraft' | 'answerQuestion' | 'useProposal' | 'dropCriterion' | 'requestInboxScan' | 'refreshCard'>;
  repo: Pick<Repo, 'fetch' | 'mainSha' | 'syncMain' | 'readFile' | 'listTree' | 'addTaskWorktree' | 'commitInWorktree'>;
  clock: Clock;
  /** Read on every use so a SIGHUP reload applies. */
  config: () => { git: { fetch_interval_ms: number } };
  log?: Log;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function question(value: DraftQuestion): { text: string; quick_answers: string[] } {
  return typeof value === 'string' ? { text: value, quick_answers: [] } : { text: value.text, quick_answers: value.quick_answers ?? [] };
}

/**
 * Intake drafts from text and the inbox (CAP-6..9; AD-5, AD-9, AD-21), in the composition root: routes
 * Owner text to `new_draft` or `draft_reply`, maps Intake output to rows and `draft_ready`, imports
 * inbox files, runs the Draft card's button commands, and the Branch effects of approval. Every Task
 * change goes through the Coordinator.
 */
export class Intake {
  readonly #store: Store;
  readonly #coordinator: IntakeOptions['coordinator'];
  readonly #repo: IntakeOptions['repo'];
  readonly #clock: Clock;
  readonly #config: IntakeOptions['config'];
  readonly #log: Log;
  /** Monotonic time of each Project's last scan request. */
  readonly #lastScan = new Map<string, number>();

  constructor(options: IntakeOptions) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
    this.#repo = options.repo;
    this.#clock = options.clock;
    this.#config = options.config;
    this.#log = options.log ?? silentLog;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  /** `origin/main` of the Project's clone, or null when it cannot be read. */
  async #mainSha(project: Project): Promise<string | null> {
    try {
      return (await this.#repo.mainSha(project.name)) ?? null;
    } catch (error) {
      this.#log.warn({ event: 'main_sha_unreadable', project_id: project.id, error: errorText(error) }, 'main_sha_unreadable');
      return null;
    }
  }

  /** The Evidence kinds of the Recipe at `sha` (AD-22), or undefined when it cannot be read or is invalid. */
  async #evidenceKinds(project: Project, sha: string | null): Promise<EvidenceKind[] | undefined> {
    if (sha === null) return undefined;
    const text = await this.#repo.readFile(project.name, sha, RECIPE_FILE).catch(() => undefined);
    const recipe = text === undefined ? undefined : validateRecipeText(text);
    return recipe?.ok === true ? recipe.recipe.evidence_kinds : undefined;
  }

  #message(taskId: string, sender: IntakeMessageRow['sender'], text: string, messageId: number | null = null): IntakeMessageRow {
    return { id: ulid(), task_id: taskId, sender, text, message_id: messageId, at: this.#now() };
  }

  /**
   * Owner text that is not a command (CAP-7): a reply to a Draft card revises that draft, anything else
   * is a `new_draft` with its own scratch draft and Intake Stage. A reply while the discard is pending
   * undoes it first; a reply while Intake is revising the draft is recorded, and that run's `draft_ready`
   * carries it so Intake reruns with it.
   */
  async onText(input: InboundMessage): Promise<void> {
    const { project } = input;
    const text = input.text.trim();
    if (project === undefined || text === '') return;
    const reply = input.replyTo;
    if (reply?.kind === DRAFT_CARD && reply.task_id !== null) {
      let task = this.#store.getTask(reply.task_id);
      if (task?.project_id === project.id) {
        if (task.state === 'discard_pending') {
          await this.#coordinator.applyEvent(task.id, { type: 'undone' });
          task = this.#store.getTask(task.id);
        }
        if (task?.state === 'draft' && this.#store.latestContract(task.id) !== undefined) {
          this.#store.insertIntakeMessage(this.#message(task.id, 'owner', text, input.messageId));
          return;
        }
        if (task?.state === 'awaiting_approval') {
          const result = await this.#coordinator.applyEvent(task.id, { type: 'draft_reply', text }, (t) =>
            this.#store.insertIntakeMessage(this.#message(t.id, 'owner', text, input.messageId)),
          );
          if (result.applied) return;
        }
      }
    }
    const configSha = await this.#mainSha(project);
    await this.#coordinator.createTask({
      project_id: project.id,
      kind: 'feature',
      config_sha: configSha,
      intake: true,
      source: { text },
      rows: (task) => this.#store.insertIntakeMessage(this.#message(task.id, 'owner', text, input.messageId)),
    });
  }

  /**
   * The Intake output hook (AD-9): `new_draft` writes the next contract version and its questions,
   * `draft_reply` naming this draft records answers, both ending in `draft_ready`; `not_actionable`
   * cancels a scratch draft silently (a revised draft goes back to its card). Any other instruction,
   * or a `draft_reply` naming another draft, is unhandled until targeting exists (1-14).
   */
  readonly outputHook: OutputHook = async ({ task, stage, output, usage }): Promise<Event | HookResult | undefined> => {
    const parsed = ownerInstructionSchema.safeParse(output);
    if (!parsed.success || task.state !== 'draft') return undefined;
    const { instructions } = parsed.data;
    let newDraft: Extract<(typeof instructions)[number], { kind: 'new_draft' }> | undefined;
    let draftReply: Extract<(typeof instructions)[number], { kind: 'draft_reply' }> | undefined;
    let notActionable = false;
    for (const instruction of instructions) {
      if (instruction.kind === 'new_draft') newDraft = instruction;
      else if (instruction.kind === 'draft_reply') draftReply = instruction;
      else if (instruction.kind === 'not_actionable') notActionable = true;
      else return undefined;
    }
    const hasContract = this.#store.latestContract(task.id) !== undefined;
    // Owner replies that arrived after this run launched are not in its brief: Intake reruns with them.
    // The row, not the launch-time object, holds `started_at`.
    const startedAt = this.#store.getStage(stage.id)?.started_at ?? stage.started_at;
    const started = startedAt === null ? undefined : Date.parse(startedAt);
    const replies = started === undefined || !hasContract ? [] : this.#store.intakeMessagesOf(task.id).filter((m) => m.sender === 'owner' && Date.parse(m.at) > started);
    const ready: Event = { type: 'draft_ready', stage_id: stage.id, usage, ...(replies.length === 0 ? {} : { reply: replies.map((m) => m.text).join('\n\n') }) };
    if (notActionable) {
      if (newDraft !== undefined || draftReply !== undefined) return undefined;
      return hasContract ? ready : { type: 'cancel', stage_id: stage.id, usage };
    }
    if (draftReply !== undefined && draftReply.draft_id !== task.id) return undefined;
    if (newDraft === undefined && !hasContract) return undefined;
    const project = this.#store.getProject(task.project_id);
    if (project === undefined) return undefined;
    const evidenceKinds = (await this.#evidenceKinds(project, task.config_sha)) ?? [...EVIDENCE_KINDS];
    let draft: DraftInput | undefined;
    if (newDraft !== undefined) {
      const questions = newDraft.questions.map(question);
      if (parsed.data.question !== undefined) questions.push(question(parsed.data.question));
      draft = { title: newDraft.title, goal: newDraft.goal, criteria: newDraft.criteria, questions: questions.slice(0, MAX_OPEN_QUESTIONS) };
    }
    const answers = draftReply?.answers ?? [];
    return {
      event: ready,
      rows: () => {
        const at = this.#now();
        // Answers first: a revision replaces only the questions still open after them.
        if (answers.length > 0) recordAnswers(this.#store, task.id, answers);
        if (draft !== undefined) writeDraft(this.#store, task.id, draft, evidenceKinds, at);
      },
    };
  };

  /** Requests a fetch and inbox scan of every registered Project at boot and every `git.fetch_interval_ms` (AD-5). */
  async tick(): Promise<void> {
    const mono = this.#clock.monotonicMs();
    const interval = this.#config().git.fetch_interval_ms;
    for (const project of this.#store.listProjects()) {
      if (project.repo_url === null) continue;
      const last = this.#lastScan.get(project.id);
      if (last !== undefined && mono - last < interval) continue;
      this.#lastScan.set(project.id, mono);
      try {
        await this.#coordinator.requestInboxScan(project.id);
      } catch (error) {
        this.#log.error({ event: 'inbox_scan_request_failed', project_id: project.id, error: errorText(error) }, 'inbox_scan_request_failed');
      }
    }
  }

  /**
   * The `scan_inbox` handler (AD-5, CAP-6): fetch, fast-forward `_main`, then offer every new
   * `.antipod/inbox/*.yaml|*.md` on `main`. A `(path, blob_sha)` already recorded is never offered
   * again; a new blob at a path whose Task is still open waits; one whose Task is terminal is a new draft.
   */
  async scanInbox(effect: EffectOf<'scan_inbox'>): Promise<void> {
    const project = this.#store.getProject(effect.project_id);
    if (project === undefined || project.repo_url === null) return;
    const fields = { project_id: project.id };
    try {
      await this.#repo.fetch(project.name);
    } catch (error) {
      this.#log.warn({ event: 'inbox_fetch_failed', ...fields, error: errorText(error) }, 'inbox_fetch_failed');
      return;
    }
    const sha = await this.#mainSha(project);
    if (sha === null) return;
    await this.#repo.syncMain(project.name).catch((error: unknown) => {
      this.#log.warn({ event: 'main_sync_failed', ...fields, error: errorText(error) }, 'main_sync_failed');
    });
    const entries = await this.#repo.listTree(project.name, sha, INBOX_DIR);
    const evidenceKinds = (await this.#evidenceKinds(project, sha)) ?? [];
    for (const entry of entries) {
      if (!INBOX_FILE.test(entry.path) || this.#store.getContractSource(project.id, entry.path, entry.blob_sha) !== undefined) continue;
      const open = this.#store.contractSourcesAt(project.id, entry.path).some((row) => {
        const task = this.#store.getTask(row.task_id);
        return task !== undefined && !TERMINAL_STATES.includes(task.state);
      });
      if (open) continue;
      try {
        const text = await this.#repo.readFile(project.name, sha, entry.path);
        if (text === undefined) continue;
        await this.#import(project, sha, entry, text, evidenceKinds);
        this.#log.info({ event: 'inbox_imported', ...fields, path: entry.path, blob_sha: entry.blob_sha }, 'inbox_imported');
      } catch (error) {
        // One bad file never stops the others; it is offered again at the next scan.
        this.#log.error({ event: 'inbox_import_failed', ...fields, path: entry.path, blob_sha: entry.blob_sha, error: errorText(error) }, 'inbox_import_failed');
      }
    }
  }

  /** A complete Task Contract becomes rows and a Draft card with no Stage; any other file goes through Intake. */
  async #import(project: Project, sha: string, entry: { path: string; blob_sha: string }, text: string, evidenceKinds: readonly EvidenceKind[]): Promise<void> {
    const at = this.#now();
    const source = { path: entry.path, blob_sha: entry.blob_sha };
    const recordSource = (task: Task): void => {
      this.#store.insertContractSource({ project_id: project.id, ...source, task_id: task.id, created_at: at });
      this.#store.insertIntakeMessage(this.#message(task.id, 'inbox', `${entry.path}\n\n${text}`));
    };
    if (entry.path.endsWith('.yaml')) {
      let document: unknown;
      try {
        document = parseYaml(text);
      } catch {
        document = undefined;
      }
      const file = contractFileSchema.safeParse(document);
      if (file.success && isCompleteContract(file.data, evidenceKinds)) {
        const contract = file.data;
        await this.#coordinator.createTask({
          project_id: project.id,
          kind: 'feature',
          config_sha: sha,
          ready: true,
          source,
          ...(contract.iteration_budget === undefined ? {} : { budget_limit: contract.iteration_budget }),
          rows: (task) => {
            recordSource(task);
            const criteria = activeCriteria(contract.criteria.map((c) => ({ ...c, status: c.status ?? 'active' }))).map((c) => ({
              text: c.text,
              required_evidence: c.required_evidence as EvidenceKind,
            }));
            writeDraft(this.#store, task.id, { title: contract.title, goal: contract.goal, criteria, questions: [], depends_on: contract.depends_on }, evidenceKinds, at);
          },
        });
        return;
      }
    }
    await this.#coordinator.createTask({ project_id: project.id, kind: 'feature', config_sha: sha, intake: true, source, rows: recordSource });
  }

  /** The `prepare_branch` handler: Branch `antipod/<task_no>-<slug>` and worktree from `config_sha` (AD-5). Idempotent. */
  async prepareBranch(effect: EffectOf<'prepare_branch'>): Promise<string> {
    const task = this.#store.getTask(effect.task_id);
    if (task === undefined || task.task_no === null) throw new Error(`task ${effect.task_id} has no number`);
    const project = this.#store.getProject(task.project_id);
    if (project === undefined) throw new Error(`project ${task.project_id} does not exist`);
    const base = task.config_sha ?? (await this.#mainSha(project));
    if (base === null) throw new Error(`${project.name} has no main to branch from`);
    return this.#repo.addTaskWorktree(project.name, task.task_no, task.slug ?? slugOf(task.title ?? 'task'), base);
  }

  /**
   * The `commit_contract` handler (AD-21): writes `.antipod/tasks/<task_no>.yaml` from the rows and
   * commits `antipod: contract v<version>` on the Branch, removing the source inbox file while it is
   * still the imported blob (so only the first commit does, and a newer blob there is kept). Commits nothing when the Branch already holds this version.
   */
  async commitContract(effect: EffectOf<'commit_contract'>): Promise<void> {
    const task = this.#store.getTask(effect.task_id);
    const contract = this.#store.latestContract(effect.task_id);
    if (task === undefined || contract === undefined || task.task_no === null) return;
    const worktree = await this.prepareBranch({ kind: 'prepare_branch', task_id: task.id });
    const yaml = projectContract({
      task_no: task.task_no,
      version: contract.version,
      title: task.title ?? titleFromGoal(contract.goal),
      goal: contract.goal,
      depends_on: contract.depends_on,
      criteria: this.#store.criteriaOf(task.id),
    });
    const source = this.#store.contractSourceOfTask(task.id);
    const removals = source === undefined ? [] : [{ path: source.path, blob_sha: source.blob_sha }];
    const commit = await this.#repo.commitInWorktree(worktree, { [contractPath(task.task_no)]: yaml }, removals, contractCommitMessage(contract.version));
    this.#log.info({ event: 'contract_committed', task_id: task.id, version: contract.version, commit: commit ?? null }, 'contract_committed');
  }

  /**
   * The Draft card's redraw payload: from the rows, with `Discarded` for a discarded draft. Undefined for a
   * Task cancelled any other way, which the card cannot show: it then only loses its buttons.
   */
  #redrawPayload(task: Task): Record<string, unknown> | undefined {
    if (task.state !== 'cancelled') return {};
    const entry = this.#store.stageEventsOfTask(task.id).findLast((row) => row.status === 'applied' && row.to_state === 'cancelled');
    return entry?.from_state === 'discard_pending' ? { closed: 'discarded' } : undefined;
  }

  /**
   * The Draft card's buttons (AD-9, AD-10): Coordinator commands bound to the states they act in. A tap that
   * cannot act names the Task's state and redraws the card (EXPERIENCE.md → Stale button).
   */
  callbacks(): Array<[string, CallbackCommand]> {
    const open = ['awaiting_approval'] as const;
    const stale = { stale: true };
    const redraw = {
      redraw: async (task: Task) => {
        const payload = this.#redrawPayload(task);
        return payload !== undefined && (await this.#coordinator.refreshCard(task.id, DRAFT_CARD, task.state, payload));
      },
    };
    const argNumber = (args: Record<string, unknown>, key: string): number => Number(args[key]);
    return [
      [
        ANSWER,
        {
          states: open,
          stale: redraw,
          handle: async ({ callback, task }) => {
            const ok = await this.#coordinator.answerQuestion(task!.id, argNumber(callback.args, 'q_no'), String(callback.args['answer']));
            return ok ? { toast: TOAST.answered } : stale;
          },
        },
      ],
      [
        USE_PROPOSAL,
        {
          states: open,
          stale: redraw,
          handle: async ({ callback, task }) => ((await this.#coordinator.useProposal(task!.id, argNumber(callback.args, 'ac_no'))) ? { toast: TOAST.proposal } : stale),
        },
      ],
      [
        DROP,
        {
          states: open,
          stale: redraw,
          handle: async ({ callback, task }) => {
            const acNo = argNumber(callback.args, 'ac_no');
            return (await this.#coordinator.dropCriterion(task!.id, acNo)) ? { toast: TOAST.dropped(acNo) } : stale;
          },
        },
      ],
      [
        APPROVE,
        {
          states: open,
          stale: redraw,
          handle: async ({ task }) => {
            const project = this.#store.getProject(task!.project_id);
            if (project === undefined) return stale;
            // `config_sha` and feasibility come from the current `main`, not the last periodic fetch.
            await this.#repo.fetch(project.name).catch((error: unknown) => {
              this.#log.warn({ event: 'approve_fetch_failed', project_id: project.id, error: errorText(error) }, 'approve_fetch_failed');
            });
            const sha = (await this.#mainSha(project)) ?? task!.config_sha;
            const kinds = await this.#evidenceKinds(project, sha);
            if (kinds === undefined) return { toast: TOAST.noRecipe };
            const result = await this.#coordinator.approveDraft(task!.id, { config_sha: sha, evidence_kinds: kinds });
            return { toast: result.ok ? TOAST.queued : `Can't approve: ${result.reason}` };
          },
        },
      ],
      [
        DISCARD,
        {
          states: open,
          stale: redraw,
          handle: async ({ task }) => ((await this.#coordinator.applyEvent(task!.id, { type: 'discarded' })).applied ? { toast: TOAST.discarded } : stale),
        },
      ],
      [
        UNDO,
        {
          states: ['discard_pending'],
          stale: redraw,
          handle: async ({ task }) => ((await this.#coordinator.applyEvent(task!.id, { type: 'undone' })).applied ? { toast: TOAST.restored } : stale),
        },
      ],
    ];
  }
}
