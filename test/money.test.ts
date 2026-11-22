import fc from "fast-check";
import {
  allocate,
  divCeil,
  divHalfEven,
  formatCents,
  MoneyError,
  parseDollars,
  parsePercentToBps,
  splitEvenly,
} from "../src/money.ts";

const cents = fc.integer({ min: 0, max: 10_000_000_00 });

describe("parseDollars / formatCents", () => {
  it.each([
    ["0", 0],
    ["12", 1200],
    ["12.5", 1250],
    ["12.05", 1205],
    ["$1,234.56", 123456],
    ["  1234.56 ", 123456],
    ["-3.10", -310],
    ["-0", 0],
  ])("parses %j as %i cents", (input, expected) => {
    expect(parseDollars(input)).toBe(expected);
  });

  it.each(["", "abc", "1.234", "1,23.00", "12.", "1e3", "$-5", "0x10", "1,2345"])("rejects %j", (input) => {
    expect(() => parseDollars(input)).toThrow(MoneyError);
  });

  it("does not take the float route: 0.1 + 0.2 stays exact", () => {
    expect(parseDollars("0.1") + parseDollars("0.2")).toBe(parseDollars("0.3"));
  });

  it("formats with thousands separators and a sign", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(-310)).toBe("-$3.10");
  });

  it("accepts the largest safe amount and rejects one cent more", () => {
    expect(parseDollars("90,071,992,547,409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseDollars("90,071,992,547,409.92")).toThrow(/too large/);
  });

  it("rejects fractional cents when formatting", () => {
    expect(() => formatCents(1.5)).toThrow(MoneyError);
  });

  it("property: format then parse is the identity", () => {
    fc.assert(
      fc.property(fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }), (c) => {
        expect(parseDollars(formatCents(c))).toBe(c);
      }),
    );
  });
});

describe("rounding helpers", () => {
  it.each([
    [5n, 2n, 2n], // 2.5 -> 2 (even)
    [7n, 2n, 4n], // 3.5 -> 4 (even)
    [11n, 4n, 3n], // 2.75 -> 3
    [9n, 4n, 2n], // 2.25 -> 2
    [-5n, 2n, -2n],
    [-7n, 2n, -4n],
    [0n, 3n, 0n],
  ])("divHalfEven(%i, %i) = %i", (n, d, q) => {
    expect(divHalfEven(n, d)).toBe(q);
  });

  it("divCeil rounds up", () => {
    expect(divCeil(10n, 5n)).toBe(2n);
    expect(divCeil(11n, 5n)).toBe(3n);
    expect(divCeil(0n, 5n)).toBe(0n);
  });

  it("property: divHalfEven is within half a unit of the exact quotient", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), fc.bigInt({ min: 1n, max: 10n ** 9n }), (n, d) => {
        const q = divHalfEven(n, d);
        const err = n - q * d; // = d * (exact - q)
        expect(2n * (err < 0n ? -err : err) <= d).toBe(true);
      }),
    );
  });
});

describe("splitEvenly", () => {
  it("puts the extra cents first", () => {
    expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEvenly(10001, 4)).toEqual([2501, 2500, 2500, 2500]);
  });

  it("property: sums exactly, spread at most one cent, non-increasing", () => {
    fc.assert(
      fc.property(cents, fc.integer({ min: 1, max: 120 }), (total, n) => {
        const parts = splitEvenly(total, n);
        expect(parts).toHaveLength(n);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
        for (let i = 1; i < n; i++) expect(parts[i]!).toBeLessThanOrEqual(parts[i - 1]!);
      }),
    );
  });
});

describe("allocate", () => {
  it("splits $100 three ways without losing a cent", () => {
    expect(allocate(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
  });

  it("gives the leftover cent to the largest remainder", () => {
    // exact shares: 16.666…, 33.333…, 50 -> 17, 33, 50
    expect(allocate(100, [1, 2, 3])).toEqual([17, 33, 50]);
  });

  it("rejects bad weights", () => {
    expect(() => allocate(100, [])).toThrow(MoneyError);
    expect(() => allocate(100, [0, 0])).toThrow(MoneyError);
    expect(() => allocate(100, [1, -1])).toThrow(MoneyError);
    expect(() => allocate(100, [0.5])).toThrow(MoneyError);
  });

  it("property: sums exactly and every share is within one cent of exact", () => {
    fc.assert(
      fc.property(cents, fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 20 }), (total, weights) => {
        fc.pre(weights.some((w) => w > 0));
        const shares = allocate(total, weights);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
        const W = weights.reduce((a, w) => a + BigInt(w), 0n);
        shares.forEach((s, i) => {
          // |s - total*w/W| < 1  <=>  |s*W - total*w| < W
          const diff = BigInt(s) * W - BigInt(total) * BigInt(weights[i]!);
          expect((diff < 0n ? -diff : diff) < W).toBe(true);
          if (weights[i] === 0) expect(s).toBe(0);
        });
      }),
    );
  });
});

describe("parsePercentToBps", () => {
  it.each([
    ["0", 0],
    ["10", 1000],
    ["29.99", 2999],
    ["7.5%", 750],
  ])("%j -> %i bps", (input, bps) => {
    expect(parsePercentToBps(input)).toBe(bps);
  });

  it.each(["", "-1", "1.234", "abc"])("rejects %j", (input) => {
    expect(() => parsePercentToBps(input)).toThrow(MoneyError);
  });
});
