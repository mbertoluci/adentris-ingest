import { eventId } from './event-id';

describe('eventId (C9)', () => {
  const base = {
    patientId: 'p1',
    type: 'observation',
    ts: new Date('2026-01-01T00:00:00.000Z'),
    data: { a: 1, b: 2 },
  };

  it('is deterministic', () => {
    expect(eventId(base)).toBe(eventId({ ...base }));
  });

  it('ignores key order inside data', () => {
    expect(eventId(base)).toBe(eventId({ ...base, data: { b: 2, a: 1 } }));
  });

  it('agrees whether ts is the same instant (epoch ms, not string shape)', () => {
    expect(eventId(base)).toBe(eventId({ ...base, ts: new Date(base.ts.getTime()) }));
  });

  it('changes when ts changes', () => {
    expect(eventId(base)).not.toBe(
      eventId({ ...base, ts: new Date('2026-01-01T00:00:01.000Z') }),
    );
  });

  it('changes when data changes', () => {
    expect(eventId(base)).not.toBe(eventId({ ...base, data: { a: 2, b: 2 } }));
  });
});
