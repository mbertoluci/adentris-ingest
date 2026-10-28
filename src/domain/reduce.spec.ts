import { cursorLt, planReduction, ReduceEvent } from './reduce';

const at = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec));

const ev = (
  eventId: string,
  sec: number,
  status: 'ready' | 'queued' | 'failed',
  effect: Record<string, unknown> = {},
): ReduceEvent => ({
  eventId,
  type: 't',
  ts: at(sec),
  isReady: status === 'ready',
  isFailed: status === 'failed',
  effect,
});

describe('reduce (F3 / C1 / C4)', () => {
  it('folds a fully ready sequence in order', () => {
    const r = planReduction([ev('a', 1, 'ready', { v: 1 }), ev('b', 2, 'ready', { v: 2 })], {
      appliedThrough: null,
    });
    expect(r.state.values.v).toBe(2);
    expect(r.appliedThrough).toEqual({ ts: at(2), eventId: 'b' });
    expect(r.foldedEventIds).toEqual(['a', 'b']);
    expect(r.blocked).toBe(false);
    expect(r.regress).toBe(false);
  });

  it('stops at a transient gap without blocking', () => {
    const r = planReduction([ev('a', 1, 'ready'), ev('b', 2, 'queued'), ev('c', 3, 'ready')], {
      appliedThrough: null,
    });
    expect(r.foldedEventIds).toEqual(['a']);
    expect(r.appliedThrough).toEqual({ ts: at(1), eventId: 'a' });
    expect(r.blocked).toBe(false);
  });

  it('blocks only when the gap is a failed event (C4)', () => {
    const r = planReduction([ev('a', 1, 'ready'), ev('b', 2, 'failed'), ev('c', 3, 'ready')], {
      appliedThrough: null,
    });
    expect(r.foldedEventIds).toEqual(['a']);
    expect(r.blocked).toBe(true);
  });

  it('does not regress when a retroactive gap appears behind the cursor (C4)', () => {
    // cursor already at sec=10; a new earlier event (sec=5) is still queued
    const r = planReduction([ev('early', 5, 'queued'), ev('x', 10, 'ready')], {
      appliedThrough: { ts: at(10), eventId: 'x' },
    });
    expect(r.regress).toBe(true);
    expect(r.foldedEventIds).toEqual([]); // nothing ready at the front
  });

  it('breaks a same-ms tie by eventId, stably', () => {
    const t = at(5);
    expect(cursorLt({ ts: t, eventId: 'a' }, { ts: t, eventId: 'b' })).toBe(true);
    expect(cursorLt({ ts: t, eventId: 'b' }, { ts: t, eventId: 'a' })).toBe(false);
  });

  it('picks up a late event once it becomes ready (C1, full refold)', () => {
    // the earlier event is now ready: the full contiguous prefix includes it
    const r = planReduction([ev('early', 5, 'ready', { v: 'e' }), ev('x', 10, 'ready', { v: 'x' })], {
      appliedThrough: { ts: at(10), eventId: 'x' },
    });
    expect(r.regress).toBe(false);
    expect(r.foldedEventIds).toEqual(['early', 'x']);
    expect(r.state.appliedCount).toBe(2);
    expect(r.state.values.v).toBe('x'); // x is last in order
  });
});
