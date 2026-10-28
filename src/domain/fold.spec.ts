import { EMPTY_STATE, fold, FoldEvent } from './fold';

const ev = (type: string, effect: Record<string, unknown>): FoldEvent => ({ type, effect });

describe('fold', () => {
  it('folds an empty sequence to the base state', () => {
    expect(fold([])).toEqual(EMPTY_STATE);
  });

  it('counts applied events and records the last type', () => {
    const state = fold([ev('a', {}), ev('b', {})]);
    expect(state.appliedCount).toBe(2);
    expect(state.lastType).toBe('b');
  });

  it('is order-sensitive: a later effect overwrites an earlier key', () => {
    const forward = fold([ev('a', { v: 1 }), ev('b', { v: 2 })]);
    const reverse = fold([ev('b', { v: 2 }), ev('a', { v: 1 })]);
    expect(forward.values.v).toBe(2);
    expect(reverse.values.v).toBe(1);
  });
});
