import { describe, expect, it } from 'vitest';
import { ulid, ULID_PATTERN } from '../../../src/core/domain/ids.ts';

describe('ulid (AD-16)', () => {
  it('is 26 Crockford base32 characters encoding the time first', () => {
    const id = ulid(Date.UTC(2026, 10, 8));
    expect(id).toMatch(ULID_PATTERN);
    expect(ulid(Date.UTC(2026, 10, 8)).slice(0, 10)).toBe(id.slice(0, 10));
  });

  it('sorts in minting order within one millisecond and across time', () => {
    const t = Date.UTC(2026, 10, 8, 1, 2, 3);
    const same = [ulid(t), ulid(t), ulid(t)];
    expect([...same].sort()).toEqual(same);
    expect(new Set(same).size).toBe(3);
    const later = ulid(t + 1);
    expect(later > same[2]!).toBe(true);
    const many = Array.from({ length: 2000 }, () => ulid());
    expect([...many].sort()).toEqual(many);
    expect(new Set(many).size).toBe(many.length);
  });
});
