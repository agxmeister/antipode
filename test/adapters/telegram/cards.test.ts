import { afterEach, describe, expect, it } from 'vitest';
import { backOnlineCard } from '../../../src/adapters/telegram/cards/back-online.ts';
import {
  CAPTION_LIMIT,
  clip,
  escapeHtml,
  fit,
  keyboard,
  TEXT_LIMIT,
  visibleLength,
  type CardEnv,
} from '../../../src/adapters/telegram/cards/card.ts';
import { deliveryFailedCard } from '../../../src/adapters/telegram/cards/delivery-failed.ts';
import { usageWindowResumedCard } from '../../../src/adapters/telegram/cards/usage-window-resumed.ts';
import { usageWindowWaitCard } from '../../../src/adapters/telegram/cards/usage-window-wait.ts';
import { ULID_PATTERN } from '../../../src/core/domain/ids.ts';
import { fakeClock } from '../../helpers/clock.ts';
import { openTestStore, type TestStore } from '../../helpers/store.ts';

let open: TestStore[] = [];
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

function env(timeZone = 'UTC'): CardEnv & { ts: TestStore } {
  const ts = openTestStore();
  open.push(ts);
  return { ts, store: ts.store, clock: fakeClock(), timeZone };
}

function text(drafts: ReturnType<typeof deliveryFailedCard.render>): string {
  return String(drafts[0]?.payload.params['text']);
}

describe('card helpers', () => {
  it('escapes HTML and measures visible length with tags removed and entities decoded', () => {
    expect(escapeHtml('a < b && "c" > d')).toBe('a &lt; b &amp;&amp; &quot;c&quot; &gt; d');
    expect(visibleLength('<b>#3 · AC1</b> &lt;ok&gt;')).toBe('#3 · AC1 <ok>'.length);
  });

  it('clip leaves short text alone and ends clipped text with …, never splitting a surrogate pair', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('abcdef', 4)).toBe('abc…');
    const emoji = `ab${'😀'.repeat(3)}`;
    const clipped = clip(emoji, 4);
    expect(clipped).toBe('ab…');
    expect(clipped.length).toBeLessThanOrEqual(4);
  });

  it('fit clips a free-text field so the whole visible text is exactly 4096, or 1024 for a caption', () => {
    const long = '<x>'.repeat(3000);
    const message = fit((field) => `<b>#12 · title</b> ${field}`, long);
    expect(visibleLength(message)).toBe(TEXT_LIMIT);
    expect(message.endsWith('…')).toBe(true);
    expect(message).not.toContain('<x>');
    const caption = fit((field) => `<b>#12 · AC1</b> ✅ ${field}`, 'y'.repeat(2000), CAPTION_LIMIT);
    expect(visibleLength(caption)).toBe(CAPTION_LIMIT);
    expect(caption.endsWith('…')).toBe(true);
  });

  it('keyboard inserts one callbacks row per button and uses cb:<ulid> within 64 bytes', () => {
    const e = env();
    const markup = keyboard(e, [[{ text: 'Accept', command: 'accept', round: 2 }, { text: 'Request changes', command: 'request_changes', round: 2 }]]);
    const buttons = markup.inline_keyboard[0] ?? [];
    expect(buttons.map((b) => b.text)).toEqual(['Accept', 'Request changes']);
    for (const button of buttons) {
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
      const id = button.callback_data.slice(3);
      expect(button.callback_data.startsWith('cb:')).toBe(true);
      expect(id).toMatch(ULID_PATTERN);
      expect(e.store.getCallback(id)).toMatchObject({ round: 2, task_id: null, expires_at: null, args: {} });
    }
    expect(e.store.getCallback(buttons[0]!.callback_data.slice(3))?.command).toBe('accept');
  });
});

describe('notice templates', () => {
  it('usage_window_wait: ⏸ line with the local reset time, replying to the card', () => {
    const e = env('UTC');
    const [draft] = usageWindowWaitCard.render({ task_id: 't1', task_no: 12, resets_at: '2026-11-08T14:20:00.000Z', reply_to: 55 }, e);
    expect(draft).toMatchObject({
      kind: 'usage_window_wait',
      task_id: 't1',
      payload: { method: 'sendMessage', params: { text: '⏸ #12 waiting for usage window · resumes ~14:20', reply_parameters: { message_id: 55 } } },
    });
    const [berlin] = usageWindowWaitCard.render({ task_id: 't1', task_no: 12, resets_at: '2026-11-08T14:20:00.000Z' }, env('Europe/Berlin'));
    expect(berlin?.payload.params['text']).toBe('⏸ #12 waiting for usage window · resumes ~15:20');
    expect(berlin?.payload.params['reply_parameters']).toBeUndefined();
  });

  it('usage_window_resumed and back_online copy', () => {
    const e = env();
    expect(usageWindowResumedCard.render({ task_id: 't1', task_no: 12 }, e)[0]?.payload.params['text']).toBe('#12 resumed');
    expect(backOnlineCard.render({ tasks: 2 }, e)[0]?.payload.params['text']).toBe('Back online · 2 Tasks resumed.');
    expect(backOnlineCard.render({ tasks: 1 }, e)[0]?.payload.params['text']).toBe('Back online · 1 Task resumed.');
  });

  it('delivery_failed copy for a Review row, another Task row and no Task; the reason is escaped and clipped', () => {
    const e = env();
    expect(text(deliveryFailedCard.render({ task_no: 12, review: true, reason: '400: Bad <file>' }, e))).toBe(
      "❌ #12 Review couldn't be delivered: 400: Bad &lt;file&gt;",
    );
    expect(text(deliveryFailedCard.render({ task_no: 12, review: false, reason: 'x' }, e))).toBe("❌ #12 message couldn't be delivered: x");
    expect(text(deliveryFailedCard.render({ task_no: null, review: false, reason: 'x' }, e))).toBe("❌ Message couldn't be delivered: x");
    const long = text(deliveryFailedCard.render({ task_no: 12, review: true, reason: 'r'.repeat(10_000) }, e));
    expect(visibleLength(long)).toBe(TEXT_LIMIT);
    expect(long.endsWith('…')).toBe(true);
  });
});
