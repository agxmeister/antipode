import { textMessage, type Card } from './card.ts';

export const BACK_ONLINE = 'back_online';

export interface BackOnlineInput {
  /** Tasks of the Project that resume after the gap. */
  tasks: number;
}

/** `Back online · 2 Tasks resumed.`, one silent notice per affected Project (EXPERIENCE.md, AD-18). */
export const backOnlineCard: Card<BackOnlineInput> = {
  kind: BACK_ONLINE,
  render(input) {
    const noun = input.tasks === 1 ? 'Task' : 'Tasks';
    return [textMessage(BACK_ONLINE, `Back online · ${input.tasks} ${noun} resumed.`)];
  },
};
