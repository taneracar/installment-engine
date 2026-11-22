# installment-engine

A small TypeScript library that turns a purchase into a payment plan (interest-free "Pay in 4" or an amortized monthly loan), applies merchant refunds, and quotes early payoff, without ever losing or inventing a cent. A React calculator in `web/` shows it in use.

The point of the project is the testing: 98 tests, 16 of them property-based with [fast-check](https://fast-check.dev/), which check invariants over thousands of random plans instead of a few examples I picked by hand. Those property tests found two real rounding problems in my first version (see [What the property tests found](#what-the-property-tests-found)).

```
npm install
npm test          # 98 tests: unit, property-based, UI (jsdom)
npm run dev       # calculator at http://localhost:5173
npm run check     # typecheck + tests + production build (what CI runs)
```

## What it does

| Function | What it gives you |
| --- | --- |
| `buildPlan({ principal, aprBps, installments, cadence, firstDueDate })` | Full schedule: due date, payment, interest, principal and balance for every installment |
| `payIn4(principal, purchaseDate)` | Four interest-free payments two weeks apart, the first at checkout |
| `applyRefund(plan, paidCount, amount)` | New schedule after a merchant refund, plus any cash that goes back to the customer |
| `payoffQuote(plan, paidCount)` | Amount that closes the loan on a due date |
| `parseDollars`, `formatCents`, `splitEvenly`, `allocate`, `divHalfEven` | The exact-money building blocks |

## Design decisions

**Money is integer cents; floats never touch an amount.** `parseDollars("0.1") + parseDollars("0.2") === parseDollars("0.3")`. Input is parsed from the string (no `parseFloat`), and more than two decimals is an error rather than a silent rounding.

**The level payment is computed exactly.** The textbook formula `P·r / (1 − (1+r)^−n)` needs fractional powers, which is where float drift comes from. With `r = bps / D` (D = periods per year × 10,000) it rearranges to

```
payment = P · bps · Aⁿ / (D · (Aⁿ − Dⁿ)),   A = D + bps
```

which is all integers, so `bigint` gives the exact rational value and there is exactly one rounding step. A test checks the result against the float formula as an independent oracle (always within one cent).

**Every rounding has a stated rule.**
- Level payment: rounded **up** to the cent, so the last installment absorbs the leftover and is never larger than the advertised payment.
- Interest per period: **half to even** (banker's rounding), so rounding errors don't lean one way across many loans.
- Splitting a total (Pay in 4, allocations): **largest remainder**, so parts sum exactly and differ by at most a cent; extra cents go first.

**Dates are `YYYY-MM-DD` strings computed in UTC.** A due date can't move because of the server's time zone or a DST change. Monthly dates are always computed from the first due date and clamped to short months, so Jan 31 → Feb 28 → **Mar 31** (chaining "add one month" drifts to Mar 28).

**Refunds come off the last unpaid installments first.** The customer's next bill stays the same, and anything beyond what is still owed comes back as cash. Applying refund *a* then *b* gives exactly the same plan as *a + b* at once (property-tested), so partial refunds can arrive in any split.

**Limits are explicit.** 1–60 installments, 0–36% APR, at least $1 of principal per installment, amounts up to `Number.MAX_SAFE_INTEGER` cents. Inputs outside them throw a `MoneyError` / `DateError` with a readable message, which the UI shows as-is.

## How it was tested

- **Known values** from standard loan calculators: $1,000 at 10% APR for 12 months is $87.92/month and $54.99 total interest; $10,000 at 6% for 60 months is $193.33.
- **Property-based invariants** (fast-check, 300–1,000 random plans each, new seeds every run):
  - principal is repaid exactly and the balance ends at 0
  - every row satisfies `payment = principal + interest`, all amounts are positive whole cents, the balance only goes down
  - every payment equals the advertised one except the last, which is never larger
  - interest-free plans charge nothing and payments differ by at most a cent
  - exact payment is within a cent of the float formula
  - a higher APR never lowers the payment
  - biweekly due dates are exactly 14 days apart; monthly ones keep the anchor day unless the month is shorter
  - refunds conserve money (`paid + still owed − cash back = price − refunds`), never touch paid installments, and are additive
  - `parseDollars(formatCents(x)) === x` for every safe integer
- **UI tests** (Testing Library + jsdom): default plan, Pay in 4, the refund simulator, error messages, payoff quote.
- **Mutation check:** I broke the code seven times by hand (removed the last-payment fix, switched to half-up rounding, removed the month-end clamp, refunded from the next payment instead of the last, gave extra cents to the last part, rounded the payment half-even, removed the overflow check). The suite caught all seven. The overflow one survived the first time, so I added a boundary test.
- **CI** runs typecheck, tests and the production build on Node 22 and 24 for every push and PR, and once a day so the property tests keep trying new random inputs.

## What the property tests found

1. **The last payment could be one cent above the advertised payment.** fast-check found a $2,311,698.31, 54-payment biweekly plan at 26.95% where the final installment came out at $56,117.76 against an advertised $56,117.75. Rounding the payment up should prevent that, but half-even rounding of each period's interest adds up to ±½ cent per period. Fix: if the final payment would exceed the advertised one, raise the advertised payment by a cent and rebuild (a property test checks this is never more than 2 cents above the exact value). Kept as a regression test.
2. **Total interest is not monotone in APR once you round to cents.** For $41.21 over 41 months, going from 21.53% to 21.61% APR *lowered* total interest by 8 cents, because the rounded-up payment retires principal a bit faster. That is correct behaviour, not a bug, but my first test assumed otherwise. The test now checks the payment is monotone and total interest stays within a cent per installment of monotone, and the exact case is pinned as a regression test.

## Honest limits

- This is a calculation library and a demo, not a lender. It is not Affirm's, Klarna's or anyone else's actual pricing, and it is not legal or compliance advice. Real products also handle late fees, daily interest accrual between due dates, grace periods, state-specific rules and disclosures (TILA/Reg Z), none of which are here.
- Interest is a periodic rate (APR ÷ 12 or ÷ 26) on the balance at each due date. Payoff quotes assume you pay on a due date, so no extra interest has accrued.
- Refunds are only supported on interest-free plans. On an interest-bearing loan a refund means re-amortizing and deciding who keeps accrued interest, which is a product decision this code doesn't make.
- Single currency with two decimal places (USD). No persistence, API or auth: the plan is a pure function of its inputs.
- `applyRefund` trusts the caller's `paidCount`; a real system would read that from the payment ledger.
- All numbers in this README come from the tests in this repo, not from production traffic.

## Layout

```
src/money.ts    integer cents, parsing/formatting, exact division and allocation
src/dates.ts    UTC calendar math, month-end clamping
src/plan.ts     plan building, level payment, payoff quote
src/refund.ts   refunds on interest-free plans
web/            React 19 + Vite calculator (no UI library)
test/           Vitest + fast-check + Testing Library
```

MIT licensed.
