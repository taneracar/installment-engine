import fc from "fast-check";
import { MoneyError } from "../src/money.ts";
import { buildPlan, LIMITS, payIn4, type Plan } from "../src/plan.ts";
import { applyRefund } from "../src/refund.ts";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const payments = (p: Plan) => p.installments.map((r) => r.payment);

describe("applyRefund examples", () => {
  const plan = payIn4(10000, "2026-11-22"); // 4 x $25

  it("takes a partial refund off the last payments first", () => {
    const { plan: after, cashBack } = applyRefund(plan, 1, 3000);
    expect(payments(after)).toEqual([2500, 2500, 2000, 0]);
    expect(cashBack).toBe(0);
    expect(after.refunded).toBe(3000);
    expect(after.installments.map((r) => r.balanceAfter).slice(1)).toEqual([2000, 0, 0]);
  });

  it("returns cash when the refund exceeds what is still owed", () => {
    const { plan: after, cashBack } = applyRefund(plan, 3, 4000);
    expect(payments(after)).toEqual([2500, 2500, 2500, 0]);
    expect(cashBack).toBe(1500);
  });

  it("a full refund before any payment cancels everything", () => {
    const { plan: after, cashBack } = applyRefund(plan, 0, 10000);
    expect(payments(after)).toEqual([0, 0, 0, 0]);
    expect(cashBack).toBe(0);
  });

  it("does not mutate the input plan", () => {
    const before = JSON.stringify(plan);
    applyRefund(plan, 1, 3000);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("rejects bad refunds", () => {
    expect(() => applyRefund(plan, 1, 0)).toThrow(MoneyError);
    expect(() => applyRefund(plan, 1, -5)).toThrow(MoneyError);
    expect(() => applyRefund(plan, 1, 10001)).toThrow(MoneyError);
    expect(() => applyRefund(plan, 5, 100)).toThrow(MoneyError);
    const once = applyRefund(plan, 0, 6000).plan;
    expect(() => applyRefund(once, 0, 4001)).toThrow(/exceed/);
    const apr = buildPlan({ principal: 50000, aprBps: 1500, installments: 6, cadence: "monthly", firstDueDate: "2026-12-01" });
    expect(() => applyRefund(apr, 0, 100)).toThrow(/interest-free/);
  });
});

const scenario = fc
  .record({
    n: fc.integer({ min: 1, max: 24 }),
    extra: fc.integer({ min: 0, max: 2_000_000 }),
    paidFrac: fc.double({ min: 0, max: 1, noNaN: true }),
    split: fc.double({ min: 0, max: 1, noNaN: true }),
    refundFrac: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ n, extra, paidFrac, split, refundFrac }) => {
    const principal = n * LIMITS.minPrincipalPerInstallment + extra;
    const plan = buildPlan({ principal, aprBps: 0, installments: n, cadence: "biweekly", firstDueDate: "2026-11-22" });
    const paidCount = Math.floor(paidFrac * (n + 1)) > n ? n : Math.floor(paidFrac * (n + 1));
    const total = Math.max(2, Math.round(refundFrac * principal));
    const a = Math.min(total - 1, Math.max(1, Math.round(split * total)));
    return { plan, paidCount, total, a, b: total - a };
  });

describe("applyRefund invariants (property-based)", () => {
  it("money is conserved: paid + still owed - cash back = price - refunds", () => {
    fc.assert(
      fc.property(scenario, ({ plan, paidCount, total }) => {
        const { plan: after, cashBack } = applyRefund(plan, paidCount, total);
        expect(after.totalPaid - cashBack).toBe(plan.input.principal - total);
        expect(cashBack).toBeGreaterThanOrEqual(0);
        expect(cashBack).toBeLessThanOrEqual(sum(payments(plan).slice(0, paidCount)));
      }),
      { numRuns: 500 },
    );
  });

  it("paid installments are never touched and no payment goes negative or up", () => {
    fc.assert(
      fc.property(scenario, ({ plan, paidCount, total }) => {
        const after = applyRefund(plan, paidCount, total).plan;
        after.installments.forEach((r, i) => {
          const was = plan.installments[i]!;
          if (i < paidCount) expect(r).toEqual(was);
          expect(r.payment).toBeGreaterThanOrEqual(0);
          expect(r.payment).toBeLessThanOrEqual(was.payment);
        });
      }),
      { numRuns: 500 },
    );
  });

  it("the next payment only changes once all later payments are gone", () => {
    fc.assert(
      fc.property(scenario, ({ plan, paidCount, total }) => {
        fc.pre(paidCount < plan.installments.length);
        const after = applyRefund(plan, paidCount, total).plan;
        const next = paidCount;
        if (after.installments[next]!.payment !== plan.installments[next]!.payment) {
          for (const r of after.installments.slice(next + 1)) expect(r.payment).toBe(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("metamorphic: refunding a then b equals refunding a + b once", () => {
    fc.assert(
      fc.property(scenario, ({ plan, paidCount, total, a, b }) => {
        const once = applyRefund(plan, paidCount, total);
        const first = applyRefund(plan, paidCount, a);
        const second = applyRefund(first.plan, paidCount, b);
        expect(second.plan).toEqual(once.plan);
        expect(first.cashBack + second.cashBack).toBe(once.cashBack);
      }),
      { numRuns: 500 },
    );
  });
});
