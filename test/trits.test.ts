import { describe, expect, it } from "vitest";
import { crazy10, rotr10 } from "../src/malbolge/tables.js";
import { base, tritAt, canon, crazy, format, fromBigInt, fromNumber, modClass, next, offsetBig, offsetNumber, rotate, toBigInt, width } from "../src/malbolge/trits.js";

describe("trits", () => {
  it("round-trips integers", () => {
    for (let n = -100000n; n <= 100000n; n += 7n) {
      const v = fromBigInt(n);
      expect(canon(v)).toBe(v);
      expect(toBigInt(v)).toBe(n);
    }
    expect(fromBigInt(0n)).toBe("0");
    expect(fromBigInt(-1n)).toBe("2");
    expect(fromBigInt(-2n)).toBe("12");
    expect(fromBigInt(1n)).toBe("10");
    expect(toBigInt("1")).toBeNull();
    expect(format(fromNumber(59048))).toBe("...0t2222222222");
  });

  it("offsetNumber agrees with offsetBig", () => {
    for (const v of ["0", "1", "2", "12", "021", "2101", "1220", "01"]) {
      expect(BigInt(offsetNumber(v)!)).toBe(offsetBig(v));
    }
  });

  it("crazy matches the 10-trit crazy for non-negative values", () => {
    const samples = [0, 1, 2, 5, 40, 1234, 19683, 29524, 59048, 12345, 54321];
    for (const a of samples) {
      for (const d of samples) {
        const r = crazy(fromNumber(a), fromNumber(d));
        // Base of the result is crazy(0, 0) = 1; the low ten trits match the 10-trit op.
        expect(base(r)).toBe(1);
        let low = 0;
        for (let i = 9; i >= 0; i--) low = low * 3 + tritAt(r, i);
        expect(low).toBe(crazy10(a, d));
      }
    }
  });

  it("crazy on repeating bases", () => {
    // ...222 crazy ...222 = ...111
    expect(crazy("2", "2")).toBe("1");
    // ...000 crazy ...000 = ...111
    expect(crazy("0", "0")).toBe("1");
    // crazy(a=...111, d=...000) = ...000
    expect(crazy("1", "0")).toBe("0");
  });

  it("rotate with width 10 matches the 10-trit rotate for small values", () => {
    for (const x of [0, 1, 2, 3, 4, 40, 1234, 19683, 29524, 59048, 12345]) {
      expect(toBigInt(rotate(fromNumber(x), 10))).toBe(BigInt(rotr10(x)));
    }
  });

  it("rotate leaves trits beyond the width untouched", () => {
    // 3^10 + 1 with width 10: low trit 1 goes to position 9, trit 10 stays.
    const v = fromNumber(59049 + 1);
    expect(toBigInt(rotate(v, 10))).toBe(BigInt(59049 + 19683));
    expect(rotate("2", 10)).toBe("2");
    expect(rotate("1", 7)).toBe("1");
    // ...221 (-2): low ten trits 1,2,2,...  -> 2,...,2,1 then base 2
    expect(rotate("12", 10)).toBe("222222222" + "1" + "2");
  });

  it("next is +1 including across the base change", () => {
    for (let n = -3000n; n <= 3000n; n++) {
      expect(next(fromBigInt(n))).toBe(fromBigInt(n + 1n));
    }
    expect(next("1")).toBe("21");
    expect(next("21")).toBe("021");
    expect(offsetBig(next("21"))).toBe(2n);
  });

  it("modClass matches the formula", () => {
    const check = (b: bigint, v: string) => {
      const off = offsetBig(v);
      const expected = Number((((b * 29524n + off) % 282n) + 282n) % 282n);
      expect(modClass(v)).toBe(expected);
    };
    for (let n = 0n; n < 3000n; n += 13n) check(0n, fromBigInt(n));
    for (let n = -3000n; n < 0n; n += 13n) check(2n, fromBigInt(n));
    for (const v of ["1", "21", "01", "0221", "1201"]) check(1n, v);
    expect(width("1")).toBe(0);
    expect(width("2222222222" + "0")).toBe(10);
  });
});
