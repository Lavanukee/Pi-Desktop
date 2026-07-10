import { describe, expect, it } from 'vitest';
import { andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr } from './result';

describe('Result', () => {
  it('constructs and narrows ok values', () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    if (isOk(result)) expect(result.value).toBe(42);
  });

  it('constructs and narrows err values', () => {
    const result = err('nope');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBe('nope');
  });

  it('map transforms ok and passes err through', () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
    const failure = err('bad');
    expect(map(failure, (n: number) => n * 2)).toBe(failure);
  });

  it('mapErr transforms err and passes ok through', () => {
    const success = ok(1);
    expect(mapErr(success, () => 'mapped')).toBe(success);
    expect(mapErr(err('bad'), (e) => `${e}!`)).toEqual(err('bad!'));
  });

  it('andThen chains ok and short-circuits err', () => {
    const parse = (s: string) => {
      const n = Number(s);
      return Number.isNaN(n) ? err('not a number' as const) : ok(n);
    };
    expect(andThen(ok('2'), parse)).toEqual(ok(2));
    expect(andThen(ok('x'), parse)).toEqual(err('not a number'));
    const failure = err('not a number' as const);
    expect(andThen(failure, parse)).toBe(failure);
  });

  it('unwrapOr falls back only for err', () => {
    expect(unwrapOr(ok(5), 0)).toBe(5);
    expect(unwrapOr(err('bad'), 0)).toBe(0);
  });
});
