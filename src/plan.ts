import { addDays, addMonthsClamped, assertIsoDate, type IsoDate } from "./dates.ts";
import { assertCents, divCeil, divHalfEven, MoneyError, splitEvenly, type Cents } from "./money.ts";

export type Cadence = "biweekly" | "monthly";

export interface PlanInput {
  /** Amount financed, in cents. */
  principal: Cents;
  /** Annual percentage rate in basis points: 2999 = 29.99%. */
  aprBps: number;
  /** Number of payments. */
  installments: number;
  cadence: Cadence;
  /** Due date of the first payment (for Pay in 4 this is the purchase date). */
  firstDueDate: IsoDate;
}

export interface Installment {
  number: number;
  dueDate: IsoDate;
  payment: Cents;
  interest: Cents;
  principal: Cents;
  /** Principal still owed after this payment. */
  balanceAfter: Cents;
}

export interface Plan {
  input: PlanInput;
  /** The advertised payment. Every payment equals it except possibly the last. */
  regularPayment: Cents;
  installments: Installment[];
  totalInterest: Cents;
  totalPaid: Cents;
  /** Cumulative refunds applied to this plan (see refund.ts). */
  refunded: Cents;
}

export const LIMITS = {
  maxInstallments: 60,
  /** 36% APR, the cap many US state lending laws use. */
  maxAprBps: 3600,
  /** At least $1 of principal per installment, so no payment rounds to zero. */
  minPrincipalPerInstallment: 100,
} as const;

const PERIODS_PER_YEAR: Record<Cadence, bigint> = { monthly: 12n, biweekly: 26n };

export function validatePlanInput(input: PlanInput): void {
  const { principal, aprBps, installments, cadence, firstDueDate } = input;
  assertCents(principal, "principal");
  if (!Number.isInteger(installments) || installments < 1 || installments > LIMITS.maxInstallments) {
    throw new MoneyError(`installments must be an integer from 1 to ${LIMITS.maxInstallments}`);
  }
  if (!Number.isInteger(aprBps) || aprBps < 0 || aprBps > LIMITS.maxAprBps) {
    throw new MoneyError(`APR must be from 0% to ${LIMITS.maxAprBps / 100}%`);
  }
  if (principal < installments * LIMITS.minPrincipalPerInstallment) {
    throw new MoneyError(
      `principal must be at least $${LIMITS.minPrincipalPerInstallment / 100} per installment`,
    );
  }
  if (cadence !== "monthly" && cadence !== "biweekly") throw new MoneyError(`unknown cadence "${cadence}"`);
  assertIsoDate(firstDueDate);
}

export function dueDates(first: IsoDate, cadence: Cadence, count: number): IsoDate[] {
  return Array.from({ length: count }, (_, i) =>
    cadence === "monthly" ? addMonthsClamped(first, i) : addDays(first, 14 * i),
  );
}

/**
 * Level payment for an amortizing loan, computed exactly with rationals:
 *
 *   payment = P * r / (1 - (1 + r)^-n),  r = bps / (periodsPerYear * 10_000)
 *
 * With D = periodsPerYear * 10_000 and A = D + bps this is
 *
 *   payment = P * bps * A^n / (D * (A^n - D^n))
 *
 * which is all integers, so bigint gives the exact value before one rounding.
 * We round UP to the cent: the last payment then absorbs the leftover and
 * (checked by property tests) never exceeds the advertised payment.
 */
export function levelPayment(principal: Cents, aprBps: number, installments: number, cadence: Cadence): Cents {
  if (aprBps === 0) return Math.ceil(principal / installments);
  const D = PERIODS_PER_YEAR[cadence] * 10_000n;
  const A = D + BigInt(aprBps);
  const An = A ** BigInt(installments);
  const Dn = D ** BigInt(installments);
  return Number(divCeil(BigInt(principal) * BigInt(aprBps) * An, D * (An - Dn)));
}

/** Interest for one period on `balance`, rounded half to even. */
export function periodInterest(balance: Cents, aprBps: number, cadence: Cadence): Cents {
  const D = PERIODS_PER_YEAR[cadence] * 10_000n;
  return Number(divHalfEven(BigInt(balance) * BigInt(aprBps), D));
}

export function buildPlan(input: PlanInput): Plan {
  validatePlanInput(input);
  const { principal, aprBps, installments: n, cadence, firstDueDate } = input;
  const dates = dueDates(firstDueDate, cadence, n);

  if (aprBps === 0) {
    // Interest-free: split exactly, larger payments first.
    const amounts = splitEvenly(principal, n);
    let balance = principal;
    const rows = amounts.map((payment, i) => {
      balance -= payment;
      return { number: i + 1, dueDate: dates[i]!, payment, interest: 0, principal: payment, balanceAfter: balance };
    });
    return { input, regularPayment: amounts[0]!, installments: rows, totalInterest: 0, totalPaid: principal, refunded: 0 };
  }

  // Per-period interest rounding can push the last payment a cent or two above
  // the level payment (found by the property tests: $56,117.76 vs $56,117.75).
  // A customer should never see a final bill bigger than the advertised one, so
  // nudge the advertised payment up a cent until the schedule honours that.
  let regular = levelPayment(principal, aprBps, n, cadence);
  let rows = amortize(input, regular, dates);
  while (rows.at(-1)!.payment > regular) {
    regular += 1;
    rows = amortize(input, regular, dates);
  }
  const totalInterest = rows.reduce((a, r) => a + r.interest, 0);
  return { input, regularPayment: regular, installments: rows, totalInterest, totalPaid: principal + totalInterest, refunded: 0 };
}

function amortize(input: PlanInput, regular: Cents, dates: IsoDate[]): Installment[] {
  const { principal, aprBps, installments: n, cadence } = input;
  const rows: Installment[] = [];
  let balance = principal;
  for (let i = 0; i < n; i++) {
    const interest = periodInterest(balance, aprBps, cadence);
    const last = i === n - 1;
    const principalPart = last ? balance : Math.min(regular - interest, balance);
    balance -= principalPart;
    rows.push({
      number: i + 1,
      dueDate: dates[i]!,
      payment: principalPart + interest,
      interest,
      principal: principalPart,
      balanceAfter: balance,
    });
  }
  return rows;
}

/** "Pay in 4": four interest-free payments two weeks apart, the first at checkout. */
export function payIn4(principal: Cents, purchaseDate: IsoDate): Plan {
  return buildPlan({ principal, aprBps: 0, installments: 4, cadence: "biweekly", firstDueDate: purchaseDate });
}

/**
 * Amount that clears the loan right after `paidCount` scheduled payments.
 * Assumes payoff on that due date, so no extra interest has accrued.
 */
export function payoffQuote(plan: Plan, paidCount: number): Cents {
  const n = plan.installments.length;
  if (!Number.isInteger(paidCount) || paidCount < 0 || paidCount > n) {
    throw new MoneyError(`paidCount must be from 0 to ${n}`);
  }
  if (paidCount === 0) return plan.input.principal - plan.refunded;
  return plan.installments[paidCount - 1]!.balanceAfter;
}
