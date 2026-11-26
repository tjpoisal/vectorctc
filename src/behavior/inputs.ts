import type { Encodable } from "./sandbox.js";
import type { ParamInfo } from "./extract.js";

/**
 * Deterministic input pools per parameter type. Chosen for the edge cases agent edits tend to break: empty and
 * whitespace strings, slashes, case boundaries, numeric-looking strings with signs and rounding traps
 * ("0.019", "1.005"), negative and fractional numbers, leap days, and array lengths 0/1/many.
 */
const STRINGS: string[] = [
  "", "a", "A", "abc", "Hello World", "hello world", "fooBar", "FooBar", "foo_bar", "foo-bar", "FOO_BAR", "fooBAR baz",
  " padded ", "  ", " / ", "/", "/foo", "foo/", "//host/x", "/a/b/", "a/b", "a//b", "./a", "../a", "C:\\a\\b",
  "http://x.com/a?b=1#c", "https://x.com:8080/p/", "?q=1", "#h", "0", "7", "0.019", "12.5", "-2.5", "+12.50",
  "1,234.56", "$3.00", "abc123", "123abc", "a1B2", "é", "Ünïcode", "!", "a b c", "xxxxxxxxxxxx",
];
const NUMBERS: number[] = [0, 1, -1, 2, 3, 5, 10, 0.5, -2.5, 1.005, 0.019, 100, 1234567];
const BOOLEANS: boolean[] = [true, false];
const DATES: Date[] = [
  new Date("2026-01-01T00:00:00.000Z"),
  new Date("2026-03-15T12:30:00.000Z"),
  new Date("2025-12-31T23:59:59.000Z"),
  new Date("2024-02-29T00:00:00.000Z"),
];

export type Pool = Encodable[];

function arrayPool(element: Pool): Pool {
  const pick = (i: number): Encodable => element[i % element.length] ?? null;
  return [
    [], [pick(1)], [pick(2)], [pick(1), pick(2)], [pick(1), pick(2), pick(3)], [pick(4), pick(8), pick(9)],
    [pick(10), pick(11), pick(12), pick(13)], [pick(6), pick(6)], [pick(7), pick(5), pick(3), pick(0)],
  ];
}

function stripType(type: string): string {
  return type.replace(/\breadonly\s+/g, "").replace(/\s+/g, "");
}

/** Pool for one declared type, or null when the type cannot be generated safely. */
export function poolFor(rawType: string | null, allowStubs: boolean): Pool | null {
  if (rawType === null) return null;
  const type = stripType(rawType);
  if (type === "string") return STRINGS;
  if (type === "number") return NUMBERS;
  if (type === "boolean") return BOOLEANS;
  if (type === "Date") return DATES;
  const array = /^(?:Array<(.+)>|ReadonlyArray<(.+)>|\((.+)\)\[\]|(.+)\[\])$/.exec(type);
  if (array) {
    const inner = array[1] ?? array[2] ?? array[3] ?? array[4] ?? "";
    const elementPool = poolFor(inner, allowStubs);
    if (elementPool) return arrayPool(elementPool);
    if (!allowStubs) return null;
    return [[], [{ $stub: "item0" }], [{ $stub: "item0" }, { $stub: "item1" }]];
  }
  if (type.includes("|")) {
    const parts = type.split("|");
    const out: Pool = [];
    for (const part of parts) {
      if (part === "undefined" || part === "void") out.push(undefined);
      else if (part === "null") out.push(null);
      else if (/^(['"]).*\1$/.test(part)) out.push(part.slice(1, -1));
      else if (/^-?\d+(\.\d+)?$/.test(part)) out.push(Number(part));
      else if (part === "true" || part === "false") out.push(part === "true");
      else {
        const sub = poolFor(part, allowStubs);
        if (!sub) return null;
        out.push(...sub);
      }
    }
    return out;
  }
  if (/^(['"]).*\1$/.test(type)) return [type.slice(1, -1)];
  if (!allowStubs) return null;
  if (/^[A-Z][A-Za-z0-9_.]*(<.*>)?$/.test(type) || type.startsWith("{")) return [{ $stub: "arg" }];
  return null;
}

const MAX_TUPLES = 220;

/**
 * Argument tuples for a parameter list: the full product when small, else a deterministic stride sample, plus
 * length-boundary pairs (a string with a number equal to its length, ±1) because off-by-one is the classic slip.
 */
export function tuplesFor(params: readonly ParamInfo[], allowStubs: boolean, extra: Encodable[][] = []): Encodable[][] | null {
  const required = params.filter((p) => !p.rest);
  const pools: Pool[] = [];
  for (const param of required) {
    const pool = poolFor(param.type, allowStubs);
    if (!pool) {
      if (param.optional) break;
      return null;
    }
    pools.push(param.optional ? [undefined, ...pool] : pool);
  }
  if (pools.length === 0) return params.length === 0 ? [[]] : null;
  const total = pools.reduce((n, pool) => n * pool.length, 1);
  const tuples: Encodable[][] = [];
  const stride = total <= MAX_TUPLES ? 1 : Math.ceil(total / MAX_TUPLES) | 1;
  for (let index = 0; index < total && tuples.length < MAX_TUPLES; index += stride) {
    let rest = index;
    const tuple: Encodable[] = [];
    for (const pool of pools) {
      tuple.push(pool[rest % pool.length]);
      rest = Math.floor(rest / pool.length);
    }
    tuples.push(tuple);
  }
  const stringAt = pools.findIndex((pool) => pool === STRINGS);
  const numberAt = pools.findIndex((pool) => pool === NUMBERS || (pool[0] === undefined && pool[1] === NUMBERS[0]));
  if (stringAt >= 0 && numberAt >= 0) {
    for (const s of ["abc", "Hello World", "xxxxxxxxxxxx", "a"]) {
      for (const delta of [-1, 0, 1]) {
        const tuple: Encodable[] = pools.map((pool) => pool.find((v) => v !== undefined));
        tuple[stringAt] = s;
        tuple[numberAt] = s.length + delta;
        tuples.push(tuple);
      }
    }
  }
  for (const tuple of extra) if (tuple.length <= params.length) tuples.push(tuple);
  return tuples;
}
