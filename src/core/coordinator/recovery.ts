import { isLiveStage } from '../domain/stage.ts';
import type { Clock } from '../ports/clock.ts';
import { silentLog, type Log } from '../ports/log.ts';
import type { Store } from '../ports/store.ts';
import type { Coordinator } from './coordinator.ts';
import type { EffectExecutor } from './effects.ts';

export interface RecoveryDeps {
  store: Store;
  coordinator: Coordinator;
  executor: EffectExecutor;
  clock: Clock;
  log?: Log;
}

export interface RecoveryReport {
  /** `stages` rows found `starting` or `running` and marked `failed(restart)`. */
  stages_restarted: number;
  /** Pending `start_stage`/`run_test_step` effects whose Stage was no longer `starting`, marked `done` unlaunched. */
  effects_orphaned: number;
  /** Pending effects handed to the executor. */
  effects_replayed: number;
}

export const RESTART = 'restart';

/**
 * Crash-only boot recovery (AD-18): every live Stage failed `restart` through the normal retry
 * policy, then every pending effect re-executed, except a Stage launch whose row is no longer
 * `starting`, which is marked `done` without launching.
 */
export async function recover(deps: RecoveryDeps): Promise<RecoveryReport> {
  const { store, coordinator, executor, clock } = deps;
  const log = deps.log ?? silentLog;
  const live = store.stagesInStatus(['starting', 'running']);
  let orphaned = 0;
  const retireLaunchesOf = (stageId: string): void => {
    for (const row of store.pendingEffects()) {
      if ((row.effect.kind === 'start_stage' || row.effect.kind === 'run_test_step') && row.effect.stage_id === stageId) {
        store.markEffect(row.effect_id, 'done', clock.now().toISOString());
        orphaned++;
      }
    }
  };
  for (const stage of live) {
    // The launch of a Stage about to be failed must never run, even if a drain starts right after the commit.
    retireLaunchesOf(stage.id);
    await coordinator.applyEvent(stage.task_id, { type: 'stage_failed', stage_id: stage.id, reason: RESTART });
    // A row the Task no longer points at is stale to the Coordinator; close it directly so it never reads as live.
    if (isLiveStage(store.getStage(stage.id))) {
      store.updateStage(stage.id, { status: 'failed', reason: RESTART, ended_at: clock.now().toISOString() });
    }
    log.info({ event: 'stage_restarted', task_id: stage.task_id, stage_id: stage.id, role: stage.role, attempt: stage.attempt }, 'stage_restarted');
  }

  // Launches whose Stage ended some other way (cancelled before the executor reached it, for instance).
  for (const row of store.pendingEffects()) {
    if (row.effect.kind !== 'start_stage' && row.effect.kind !== 'run_test_step') {
      continue;
    }
    if (store.getStage(row.effect.stage_id)?.status !== 'starting') {
      store.markEffect(row.effect_id, 'done', clock.now().toISOString());
      orphaned++;
    }
  }

  const replayed = store.pendingEffects().length;
  await executor.drain();
  return { stages_restarted: live.length, effects_orphaned: orphaned, effects_replayed: replayed };
}
