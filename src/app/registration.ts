import type { Coordinator } from '../core/coordinator/coordinator.ts';
import { RepoUnreachableError } from '../core/domain/errors.ts';
import { ulid } from '../core/domain/ids.ts';
import { RECIPE_FILE } from '../core/domain/recipe.ts';
import { projectDisplayName, type Project } from '../core/domain/task.ts';
import { silentLog, type Log } from '../core/ports/log.ts';
import { STAGING_PREFIX, type Repo } from '../core/ports/repo.ts';
import type { Store } from '../core/ports/store.ts';
import { validateRecipeText } from './recipe-file.ts';

export const REGISTER_USAGE = 'usage /register <repo>';
export const NO_MAIN = 'no main branch';
export const NO_RECIPE = 'no Recipe at repo root';

export interface RegisterInput {
  /** The repo as the Owner typed it (`github.com/a/training`, a URL or an absolute path). */
  repo: string;
  chatId: number;
}

export type RegisterResult = { ok: true; project: Project; name: string } | { ok: false; reason: string };

export interface RegistrationOptions {
  store: Store;
  coordinator: Coordinator;
  repo: Repo;
  /** The chat refusal reason (not a supergroup, bot can't read all messages), or undefined when it qualifies. */
  checkChat: (chatId: number) => Promise<string | undefined>;
  log?: Log;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one registration path (AD-10), behind `/register` and `antipod register --chat-id`: checks the
 * chat, clones or fetches the repo, validates the Recipe from `origin/main` (AD-22), and only then
 * writes the Project row and binds the chat. Registrations run one at a time, so the staging-clone
 * sweep never removes a clone another registration is still using.
 */
export class Registration {
  readonly #store: Store;
  readonly #coordinator: Coordinator;
  readonly #repo: Repo;
  readonly #checkChat: RegistrationOptions['checkChat'];
  readonly #log: Log;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: RegistrationOptions) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
    this.#repo = options.repo;
    this.#checkChat = options.checkChat;
    this.#log = options.log ?? silentLog;
  }

  register(input: RegisterInput): Promise<RegisterResult> {
    const run = this.#tail.then(() => this.#register(input));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** Resolves once every registration queued so far has settled. */
  idle(): Promise<void> {
    return this.#tail.then(() => undefined);
  }

  async #register(input: RegisterInput): Promise<RegisterResult> {
    const fields = { event: 'registration', chat_id: input.chatId, repo: input.repo };
    try {
      const result = await this.#attempt(input);
      if (result.ok) {
        this.#log.info({ ...fields, event: 'registration_succeeded', project_id: result.project.id }, 'registration_succeeded');
      } else {
        this.#log.info({ ...fields, event: 'registration_refused', reason: result.reason }, 'registration_refused');
      }
      return result;
    } catch (error) {
      this.#log.error({ ...fields, event: 'registration_failed', error: errorText(error) }, 'registration_failed');
      return { ok: false, reason: errorText(error) };
    }
  }

  async #attempt(input: RegisterInput): Promise<RegisterResult> {
    if (input.repo.trim() === '') {
      return { ok: false, reason: REGISTER_USAGE };
    }
    const chatRefusal = await this.#checkChat(input.chatId);
    if (chatRefusal !== undefined) {
      return { ok: false, reason: chatRefusal };
    }
    const url = this.#repo.remoteUrl(input.repo);
    const boundHere = this.#store.projectByChat(input.chatId);
    if (boundHere !== undefined && boundHere.repo_url !== url) {
      return { ok: false, reason: `this group is already bound to ${projectDisplayName(boundHere.name)}` };
    }
    const known = this.#store.projectByRepo(url);
    if (known?.telegram_chat_id != null && known.telegram_chat_id !== input.chatId) {
      return { ok: false, reason: `${projectDisplayName(known.name)} is already registered in another group` };
    }

    // A crashed registration's staging clone goes now (design note: deleted at the next registration).
    await this.#repo.removeStaging();
    return known === undefined ? this.#registerNew(url, input.chatId) : this.#reregister(known, input.chatId);
  }

  /** A repo seen for the first time: clone into staging, validate, then promote and write the rows. */
  async #registerNew(url: string, chatId: number): Promise<RegisterResult> {
    const staging = `${STAGING_PREFIX}${ulid()}`;
    try {
      await this.#repo.ensureClone(url, staging);
    } catch (error) {
      if (error instanceof RepoUnreachableError) return { ok: false, reason: error.message };
      throw error;
    }
    let promoted: string | undefined;
    try {
      const recipe = await this.#readRecipe(staging);
      if (!recipe.ok) return recipe;
      const name = recipe.name;
      if (this.#store.projectByName(name) !== undefined) {
        return { ok: false, reason: `a Project named ${name} already exists` };
      }
      await this.#repo.promote(staging, name);
      promoted = name;
      await this.#repo.syncMain(name);
      const project = await this.#coordinator.createProject(name, url);
      this.#store.bindProjectChat(project.id, chatId);
      promoted = undefined;
      return { ok: true, project: { ...project, telegram_chat_id: chatId }, name: projectDisplayName(name) };
    } finally {
      await this.#repo.discard(staging);
      if (promoted !== undefined) await this.#repo.discard(promoted);
    }
  }

  /** A repo with a Project row (same chat, or not bound yet): fetch, re-validate, bind. */
  async #reregister(project: Project, chatId: number): Promise<RegisterResult> {
    try {
      await this.#repo.fetch(project.name);
    } catch (error) {
      if (error instanceof RepoUnreachableError) return { ok: false, reason: error.message };
      throw error;
    }
    const recipe = await this.#readRecipe(project.name);
    if (!recipe.ok) return recipe;
    if (recipe.name !== project.name) {
      const other = this.#store.projectByName(recipe.name);
      if (other !== undefined && other.id !== project.id) {
        return { ok: false, reason: `a Project named ${recipe.name} already exists` };
      }
      // The Project's name is its path key (AD-5); a renamed Recipe keeps the registered name.
      this.#log.warn({ event: 'recipe_name_changed', project_id: project.id, from: project.name, to: recipe.name }, 'recipe_name_changed');
    }
    await this.#repo.syncMain(project.name);
    if (project.telegram_chat_id !== chatId) {
      this.#store.bindProjectChat(project.id, chatId);
    }
    return { ok: true, project: { ...project, telegram_chat_id: chatId }, name: projectDisplayName(project.name) };
  }

  /** The Recipe at `origin/main` of clone `name`, validated (AD-22). */
  async #readRecipe(name: string): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
    const sha = await this.#repo.mainSha(name);
    if (sha === undefined) return { ok: false, reason: NO_MAIN };
    const text = await this.#repo.readFile(name, sha, RECIPE_FILE);
    if (text === undefined) return { ok: false, reason: NO_RECIPE };
    const validation = validateRecipeText(text);
    if (!validation.ok) return validation;
    return { ok: true, name: validation.recipe.name };
  }
}
