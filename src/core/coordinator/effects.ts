import type { Effect, EffectKind, EffectOf, EffectRow } from '../domain/effects.ts';
import type { Clock } from '../ports/clock.ts';
import { silentLog, type Log } from '../ports/log.ts';
import type { Store } from '../ports/store.ts';

export type EffectHandler<K extends EffectKind = EffectKind> = (effect: EffectOf<K>, row: EffectRow) => void | Promise<void>;

export const NO_HANDLER = 'no_handler';

/**
 * Acts second (AD-3): drains `effects` rows in insertion order after the Coordinator commits,
 * marking each `done` or `failed`. Handlers are registered by kind from the composition root;
 * a kind nobody registered fails `no_handler`. One drain runs at a time; a notify during a drain
 * schedules another pass.
 */
export class EffectExecutor {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #handlers = new Map<EffectKind, EffectHandler>();
  #draining: Promise<void> | undefined;
  #again = false;

  constructor(store: Store, clock: Clock, log: Log = silentLog) {
    this.#store = store;
    this.#clock = clock;
    this.#log = log;
  }

  register<K extends EffectKind>(kind: K, handler: EffectHandler<K>): void {
    this.#handlers.set(kind, handler as unknown as EffectHandler);
  }

  has(kind: EffectKind): boolean {
    return this.#handlers.has(kind);
  }

  /** Schedules a drain without waiting for it. */
  notify(): void {
    this.drain().catch((error: unknown) => {
      this.#log.error({ event: 'effects_drain_failed', error: String(error) }, 'effects_drain_failed');
    });
  }

  /** Runs every pending effect; resolves when the queue is empty. */
  drain(): Promise<void> {
    if (this.#draining !== undefined) {
      this.#again = true;
      return this.#draining;
    }
    this.#draining = (async () => {
      try {
        do {
          this.#again = false;
          await this.#runPending();
        } while (this.#again);
      } finally {
        this.#draining = undefined;
      }
    })();
    return this.#draining;
  }

  async #runPending(): Promise<void> {
    for (const row of this.#store.pendingEffects()) {
      // Re-read: an earlier pass or recovery may have settled this row meanwhile (idempotent by effect_id).
      if (this.#store.getEffect(row.effect_id)?.status !== 'pending') {
        continue;
      }
      await this.#runOne(row);
    }
  }

  async #runOne(row: EffectRow): Promise<void> {
    const handler = this.#handlers.get(row.kind);
    const fields = { effect_id: row.effect_id, kind: row.kind, task_id: row.task_id };
    if (handler === undefined) {
      this.#store.markEffect(row.effect_id, 'failed', this.#now(), NO_HANDLER);
      this.#log.error({ event: 'effect_failed', ...fields, error: NO_HANDLER }, 'effect_failed');
      return;
    }
    try {
      await handler(row.effect as Effect, row);
      this.#store.markEffect(row.effect_id, 'done', this.#now());
      this.#log.debug({ event: 'effect_done', ...fields }, 'effect_done');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#store.markEffect(row.effect_id, 'failed', this.#now(), message);
      this.#log.error({ event: 'effect_failed', ...fields, error: message }, 'effect_failed');
    }
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
