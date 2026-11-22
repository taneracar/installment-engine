import fc from "fast-check";
import { addDays, addMonthsClamped, assertIsoDate, DateError, daysInMonth } from "../src/dates.ts";

describe("dates", () => {
  it("knows leap years", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });

  it.each(["2026-02-29", "2026-13-01", "2026-00-10", "2026-4-1", "26-04-01", "2026-04-31", "nope"])(
    "rejects %j",
    (d) => {
      expect(() => assertIsoDate(d)).toThrow(DateError);
    },
  );

  it("adds days across month, year and a US DST change", () => {
    expect(addDays("2026-12-25", 14)).toBe("2027-01-08");
    expect(addDays("2027-03-01", 14)).toBe("2027-03-15"); // DST starts 2027-03-14 in the US
    expect(addDays("2026-10-25", 14)).toBe("2026-11-08"); // DST ends 2026-11-01
  });

  it("clamps month-end and does not drift", () => {
    const due = [0, 1, 2, 3].map((k) => addMonthsClamped("2027-01-31", k));
    expect(due).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(addMonthsClamped("2027-11-30", 3)).toBe("2028-02-29");
    expect(addMonthsClamped("2026-11-15", 14)).toBe("2028-01-15");
  });

  it("property: monthly dates stay on the anchor day unless the month is shorter", () => {
    const anchor = fc
      .record({ y: fc.integer({ min: 1990, max: 2100 }), m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 31 }) })
      .filter(({ y, m, d }) => d <= daysInMonth(y, m))
      .map(({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    fc.assert(
      fc.property(anchor, fc.integer({ min: 0, max: 120 }), (a, k) => {
        const out = addMonthsClamped(a, k);
        const [y, m, d] = out.split("-").map(Number) as [number, number, number];
        const anchorDay = Number(a.slice(8));
        expect(d).toBe(Math.min(anchorDay, daysInMonth(y, m)));
        const months = (y - Number(a.slice(0, 4))) * 12 + (m - Number(a.slice(5, 7)));
        expect(months).toBe(k);
      }),
    );
  });
});
