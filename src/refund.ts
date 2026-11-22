import { assertCents, MoneyError, type Cents } from "./money.ts";
import type { Installment, Plan } from "./plan.ts";

export interface RefundResult {
  plan: Plan;
  /** Part of the refund that could not be absorbed by unpaid installments and goes back to the customer. */
  cashBack: Cents;
}

/**
 * Apply a merchant refund to an interest-free plan after `paidCount` payments.
 *
 * Policy: the refund reduces the LAST unpaid installments first, so the
 * customer's next payment stays the same; anything beyond what is still owed
 * comes back as cash. Applying refund a then b equals applying a + b once
 * (property-tested), so partial refunds can arrive in any split.
 *
 * Interest-bearing plans are rejected on purpose: a refund there means
 * re-amortizing and deciding who keeps accrued interest, which is a product
 * decision this module does not make.
 */
export function applyRefund(plan: Plan, paidCount: number, amount: Cents): RefundResult {
  assertCents(amount, "refund");
  if (amount <= 0) throw new MoneyError("refund must be positive");
  if (plan.input.aprBps !== 0) throw new MoneyError("refunds are only supported on interest-free plans");
  const n = plan.installments.length;
  if (!Number.isInteger(paidCount) || paidCount < 0 || paidCount > n) {
    throw new MoneyError(`paidCount must be from 0 to ${n}`);
  }
  if (plan.refunded + amount > plan.input.principal) {
    throw new MoneyError("total refunds cannot exceed the purchase amount");
  }

  const rows: Installment[] = plan.installments.map((r) => ({ ...r }));
  let left = amount;
  for (let i = n - 1; i >= paidCount && left > 0; i--) {
    const cut = Math.min(rows[i]!.payment, left);
    rows[i]!.payment -= cut;
    rows[i]!.principal -= cut;
    left -= cut;
  }
  // Recompute what is owed after each unpaid row.
  let owed = 0;
  for (let i = n - 1; i >= paidCount; i--) {
    rows[i]!.balanceAfter = owed;
    owed += rows[i]!.payment;
  }

  const totalPaid = rows.reduce((a, r) => a + r.payment, 0);
  return {
    plan: { ...plan, installments: rows, totalPaid, refunded: plan.refunded + amount },
    cashBack: left,
  };
}
