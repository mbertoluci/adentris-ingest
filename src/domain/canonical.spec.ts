import { canonicalJSON } from './canonical';
import { InvalidInputError } from './errors';

describe('canonicalJSON (C9/C13)', () => {
  it('is independent of key order', () => {
    expect(canonicalJSON({ a: 1, b: 2 })).toBe(canonicalJSON({ b: 2, a: 1 }));
  });

  it('treats 1 and 1.0 as equal', () => {
    expect(canonicalJSON({ x: 1 })).toBe(canonicalJSON({ x: 1.0 }));
  });

  it('normalizes unicode so NFC and NFD agree', () => {
    const nfc = 'é'; // é, single code point
    const nfd = 'é'; // e + combining acute
    expect(nfc).not.toBe(nfd);
    expect(canonicalJSON({ name: nfc })).toBe(canonicalJSON({ name: nfd }));
  });

  it('normalizes keys before sorting so NFC and NFD keys agree with a sibling key', () => {
    const nfc = 'é'; // é
    const nfd = 'é';
    // with a second key, a naive sort on raw keys would order them differently per form
    expect(canonicalJSON({ [nfc]: 1, z: 2 })).toBe(canonicalJSON({ [nfd]: 1, z: 2 }));
  });

  it('rejects two keys that collide after NFC', () => {
    const nfc = 'é';
    const nfd = 'é';
    expect(() => canonicalJSON({ [nfc]: 1, [nfd]: 2 })).toThrow(InvalidInputError);
  });

  it('rejects nesting beyond the depth limit (the most dangerous vector)', () => {
    let deep: unknown = 0;
    for (let i = 0; i < 40; i++) {
      deep = [deep];
    }
    expect(() => canonicalJSON(deep)).toThrow(InvalidInputError);
  });

  it('rejects too many nodes (width a byte cap would miss)', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 3000; i++) {
      wide['k' + i] = i;
    }
    expect(() => canonicalJSON(wide)).toThrow(InvalidInputError);
  });

  it('rejects $-prefixed and dotted keys', () => {
    expect(() => canonicalJSON({ $gt: 1 })).toThrow(InvalidInputError);
    expect(() => canonicalJSON({ 'a.b': 1 })).toThrow(InvalidInputError);
  });

  it('rejects prototype-pollution keys, never sanitizing', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}');
    expect(() => canonicalJSON(hostile)).toThrow(InvalidInputError);
  });

  it('rejects non-finite numbers (BSON Infinity would break the re-hash)', () => {
    expect(() => canonicalJSON({ x: Infinity })).toThrow(InvalidInputError);
  });
});
