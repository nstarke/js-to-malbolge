import { describe, expect, it } from "vitest";
import { OPCODES, XLAT1, XLAT2, crazy10, decodeOp, rotr10 } from "../src/malbolge/tables.js";

describe("tables", () => {
  it("numeric opcode table agrees with XLAT1 decoding", () => {
    for (let cell = 33; cell <= 126; cell++) {
      for (let addr = 0; addr < 94; addr++) {
        const viaXlat = XLAT1[(cell - 33 + addr) % 94];
        const mnemonic = "ji*p</vo".includes(viaXlat) ? viaXlat : "nop";
        expect(decodeOp(cell, addr)).toBe(mnemonic);
      }
    }
  });

  it("translation tables are permutations of 33..126", () => {
    for (const t of [XLAT1, XLAT2]) {
      expect(t.length).toBe(94);
      const codes = [...t].map((c) => c.charCodeAt(0)).sort((a, b) => a - b);
      expect(codes).toEqual(Array.from({ length: 94 }, (_, i) => i + 33));
    }
    expect(Object.keys(OPCODES).length).toBe(8);
  });

  it("crazy10 matches Olmstead's di-trit table", () => {
    // Olmstead's 9x9 table o[y-digit][x-digit] where x plays A and y plays D.
    const o = [
      [4, 3, 3, 1, 0, 0, 1, 0, 0],
      [4, 3, 5, 1, 0, 2, 1, 0, 2],
      [5, 5, 4, 2, 2, 1, 2, 2, 1],
      [4, 3, 3, 1, 0, 0, 7, 6, 6],
      [4, 3, 5, 1, 0, 2, 7, 6, 8],
      [5, 5, 4, 2, 2, 1, 8, 8, 7],
      [7, 6, 6, 7, 6, 6, 4, 3, 3],
      [7, 6, 8, 7, 6, 8, 4, 3, 5],
      [8, 8, 7, 8, 8, 7, 5, 5, 4],
    ];
    const p9 = [1, 9, 81, 729, 6561];
    const op = (x: number, y: number) => {
      let i = 0;
      for (let j = 0; j < 5; j++) i += o[Math.floor(y / p9[j]) % 9][Math.floor(x / p9[j]) % 9] * p9[j];
      return i;
    };
    const samples = [0, 1, 2, 3, 40, 1234, 19683, 29524, 59048, 12345, 54321, 9999];
    for (const a of samples) for (const d of samples) expect(crazy10(a, d)).toBe(op(a, d));
  });

  it("rotr10 rotates right by one trit", () => {
    expect(rotr10(1)).toBe(19683);
    expect(rotr10(3)).toBe(1);
    expect(rotr10(59048)).toBe(59048);
    expect(rotr10(0)).toBe(0);
  });
});
