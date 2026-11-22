import fc from "fast-check";
import { MoneyError } from "../src/money.ts";
import { buildPlan, LIMITS, levelPayment, payIn4, payoffQuote, type Cadence, type PlanInput } from "../src/plan.ts";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Textbook float formula, used only as an independent oracle in tests. */
function floatPayment(principalCents: number, aprBps: number, n: number, periodsPerYear: number) {
  const r = aprBps / 10_000 / periodsPerYear;
  return (principalCents * r) / (1 - (1 + r) ** -n);
}

const planInput: fc.Arbitrary<PlanInput> = fc
  .record({
    installments: fc.integer({ min: 1, max: LIMITS.maxInstallments }),
    aprBps: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: LIMITS.maxAprBps })),
    cadence: fc.constantFrom<Cadence>("monthly", "biweekly"),
    extra: fc.integer({ min: 0, max: 5_000_000_00 }),
    firstDueDate: fc.constantFrom("2026-11-22", "2027-01-31", "2028-02-29", "2026-12-31"),
  })
  .map(({ installments, extra, ...rest }) => ({
    ...rest,
    installments,
    principal: installments * LIMITS.minPrincipalPerInstallment + extra,
  }));

describe("known values (checked against standard loan calculators)", () => {
  it("$1,000 at 10% APR over 12 months is $87.92 a month", () => {
    const plan = buildPlan({ principal: 100000, aprBps: 1000, installments: 12, cadence: "monthly", firstDueDate: "2026-12-01" });
    expect(plan.regularPayment).toBe(8792);
    expect(plan.installments[0]).toMatchObject({ interest: 833, principal: 7959, balanceAfter: 92041 });
    expect(plan.totalInterest).toBe(5499);
    expect(plan.totalPaid).toBe(105499);
    expect(plan.installments.at(-1)!.balanceAfter).toBe(0);
  });

  it("$10,000 at 6% APR over 60 months is $193.33 a month", () => {
    expect(levelPayment(1_000_000, 600, 60, "monthly")).toBe(19333);
  });

  it("$500 at 29.99% APR over 6 months", () => {
    // exact: 90.7724… -> rounded up to 90.78
    const plan = buildPlan({ principal: 50000, aprBps: 2999, installments: 6, cadence: "monthly", firstDueDate: "2026-12-01" });
    expect(plan.regularPayment).toBe(9078);
    expect(plan.installments[0]!.interest).toBe(1250); // 500 * 0.2999 / 12 = 12.4958 -> 12.50
  });

  it("Pay in 4: $100.01 is due today and every two weeks after", () => {
    const plan = payIn4(10001, "2026-11-22");
    expect(plan.installments.map((r) => [r.dueDate, r.payment])).toEqual([
      ["2026-11-22", 2501],
      ["2026-12-06", 2500],
      ["2026-12-20", 2500],
      ["2027-01-03", 2500],
    ]);
    expect(plan.totalInterest).toBe(0);
  });

  it("monthly due dates anchored on the 31st clamp to short months", () => {
    const plan = buildPlan({ principal: 60000, aprBps: 0, installments: 4, cadence: "monthly", firstDueDate: "2027-01-31" });
    expect(plan.installments.map((r) => r.dueDate)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  });
});

describe("validation", () => {
  const ok: PlanInput = { principal: 100000, aprBps: 1000, installments: 12, cadence: "monthly", firstDueDate: "2026-12-01" };
  it.each<[string, Partial<PlanInput>]>([
    ["zero installments", { installments: 0 }],
    ["too many installments", { installments: 61 }],
    ["fractional installments", { installments: 2.5 }],
    ["negative APR", { aprBps: -1 }],
    ["APR above cap", { aprBps: 3601 }],
    ["fractional cents", { principal: 1000.5 }],
    ["principal below $1 per installment", { principal: 1199 }],
    ["bad date", { firstDueDate: "2026-02-30" }],
    ["unknown cadence", { cadence: "weekly" as Cadence }],
  ])("rejects %s", (_, patch) => {
    expect(() => buildPlan({ ...ok, ...patch })).toThrow();
  });

  it("accepts the exact minimum principal", () => {
    expect(() => buildPlan({ ...ok, principal: 1200 })).not.toThrow();
  });
});

describe("plan invariants (property-based)", () => {
  it("principal is repaid exactly and the balance ends at zero", () => {
    fc.assert(
      fc.property(planInput, (input) => {
        const plan = buildPlan(input);
        const rows = plan.installments;
        expect(rows).toHaveLength(input.installments);
        expect(sum(rows.map((r) => r.principal))).toBe(input.principal);
        expect(rows.at(-1)!.balanceAfter).toBe(0);
        expect(sum(rows.map((r) => r.interest))).toBe(plan.totalInterest);
        expect(sum(rows.map((r) => r.payment))).toBe(plan.totalPaid);
        expect(plan.totalPaid).toBe(input.principal + plan.totalInterest);
      }),
      { numRuns: 500 },
    );
  });

  it("every row is consistent, positive, and the balance only goes down", () => {
    fc.assert(
      fc.property(planInput, (input) => {
        const rows = buildPlan(input).installments;
        let prev = input.principal;
        for (const r of rows) {
          expect(Number.isSafeInteger(r.payment)).toBe(true);
          expect(r.payment).toBe(r.principal + r.interest);
          expect(r.payment).toBeGreaterThan(0);
          expect(r.interest).toBeGreaterThanOrEqual(0);
          expect(r.principal).toBeGreaterThan(0);
          expect(r.balanceAfter).toBe(prev - r.principal);
          expect(r.balanceAfter).toBeGreaterThanOrEqual(0);
          prev = r.balanceAfter;
        }
      }),
      { numRuns: 500 },
    );
  });

  it("all payments equal the advertised payment except the last, which is never larger", () => {
    fc.assert(
      fc.property(planInput, (input) => {
        fc.pre(input.aprBps > 0);
        const plan = buildPlan(input);
        const rows = plan.installments;
        for (const r of rows.slice(0, -1)) expect(r.payment).toBe(plan.regularPayment);
        expect(rows.at(-1)!.payment).toBeLessThanOrEqual(plan.regularPayment);
      }),
      { numRuns: 1000 },
    );
  });

  it("interest-free plans charge no interest and payments differ by at most a cent", () => {
    fc.assert(
      fc.property(planInput, (input) => {
        const plan = buildPlan({ ...input, aprBps: 0 });
        const p = plan.installments.map((r) => r.payment);
        expect(plan.totalInterest).toBe(0);
        expect(Math.max(...p) - Math.min(...p)).toBeLessThanOrEqual(1);
        expect(plan.regularPayment).toBe(p[0]);
      }),
    );
  });

  it("the exact payment agrees with the float textbook formula to within a cent", () => {
    fc.assert(
      fc.property(planInput, (input) => {
        fc.pre(input.aprBps > 0);
        const exact = levelPayment(input.principal, input.aprBps, input.installments, input.cadence);
        const approx = floatPayment(input.principal, input.aprBps, input.installments, input.cadence === "monthly" ? 12 : 26);
        expect(exact).toBeGreaterThanOrEqual(Math.floor(approx - 1e-6));
        expect(exact - approx).toBeLessThan(1 + 1e-6);
      }),
      { numRuns: 500 },
    );
  });

  it("metamorphic: a higher APR never lowers the payment", () => {
    fc.assert(
      fc.property(planInput, fc.integer({ min: 1, max: 500 }), (input, bump) => {
        fc.pre(input.aprBps + bump <= LIMITS.maxAprBps);
        const lo = buildPlan(input);
        const hi = buildPlan({ ...input, aprBps: input.aprBps + bump });
        expect(hi.regularPayment).toBeGreaterThanOrEqual(lo.regularPayment);
        // Total interest is NOT strictly monotone once amounts are rounded to
        // cents: fast-check found $41.21 over 41 months where 21.53% -> 21.61%
        // APR lowered total interest by 8 cents, because the rounded-up payment
        // retires principal slightly faster. Exact math is monotone; the rounded
        // schedule stays within one cent per installment of it.
        expect(hi.totalInterest).toBeGreaterThanOrEqual(lo.totalInterest - input.installments);
      }),
      { numRuns: 300 },
    );
  });

  it("regression: the 21.53% vs 21.61% case from the property test", () => {
    const base = { cadence: "monthly" as const, firstDueDate: "2026-11-22", installments: 41, principal: 4121 };
    const lo = buildPlan({ ...base, aprBps: 2153 });
    const hi = buildPlan({ ...base, aprBps: 2161 });
    expect(hi.regularPayment).toBeGreaterThanOrEqual(lo.regularPayment);
    expect(hi.totalInterest - lo.totalInterest).toBe(-8);
  });

  it("the advertised payment is the exact level payment or at most a few cents above it", () => {
    fc.assert(
      fc.property(planInput, (input) => {
        fc.pre(input.aprBps > 0);
        const plan = buildPlan(input);
        const exact = levelPayment(input.principal, input.aprBps, input.installments, input.cadence);
        expect(plan.regularPayment - exact).toBeGreaterThanOrEqual(0);
        expect(plan.regularPayment - exact).toBeLessThanOrEqual(2);
      }),
      { numRuns: 1000 },
    );
  });

  it("regression: interest rounding no longer makes the last payment larger", () => {
    const plan = buildPlan({ aprBps: 2695, cadence: "biweekly", firstDueDate: "2026-11-22", installments: 54, principal: 231169831 });
    expect(plan.installments.at(-1)!.payment).toBeLessThanOrEqual(plan.regularPayment);
  });

  it("due dates are strictly increasing; biweekly ones are exactly 14 days apart", () => {
    fc.assert(
      fc.property(planInput, (input) => {
        const dates = buildPlan(input).installments.map((r) => r.dueDate);
        expect(dates[0]).toBe(input.firstDueDate);
        for (let i = 1; i < dates.length; i++) {
          expect(dates[i]! > dates[i - 1]!).toBe(true);
          if (input.cadence === "biweekly") {
            const gap = (Date.parse(dates[i]!) - Date.parse(dates[i - 1]!)) / 86_400_000;
            expect(gap).toBe(14);
          }
        }
      }),
    );
  });
});

describe("payoffQuote", () => {
  const plan = buildPlan({ principal: 100000, aprBps: 1000, installments: 12, cadence: "monthly", firstDueDate: "2026-12-01" });

  it("is the full principal before any payment and zero at the end", () => {
    expect(payoffQuote(plan, 0)).toBe(100000);
    expect(payoffQuote(plan, 12)).toBe(0);
    expect(payoffQuote(plan, 1)).toBe(92041);
  });

  it("paying off early saves the remaining scheduled interest", () => {
    for (let k = 0; k <= 12; k++) {
      const paid = sum(plan.installments.slice(0, k).map((r) => r.payment));
      const remainingScheduled = sum(plan.installments.slice(k).map((r) => r.payment));
      expect(payoffQuote(plan, k)).toBeLessThanOrEqual(remainingScheduled);
      expect(paid + payoffQuote(plan, k)).toBeLessThanOrEqual(plan.totalPaid);
    }
  });

  it("rejects an out-of-range count", () => {
    expect(() => payoffQuote(plan, 13)).toThrow(MoneyError);
    expect(() => payoffQuote(plan, -1)).toThrow(MoneyError);
  });
});
