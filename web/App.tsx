import { useMemo, useState } from "react";
import {
  applyRefund,
  buildPlan,
  formatCents,
  parseDollars,
  parsePercentToBps,
  payoffQuote,
  type Cadence,
  type Plan,
} from "../src/index.ts";

type Preset = { id: string; label: string; installments: number; cadence: Cadence; interestFree?: boolean };

export const PRESETS: Preset[] = [
  { id: "pay4", label: "Pay in 4", installments: 4, cadence: "biweekly", interestFree: true },
  { id: "m3", label: "3 months", installments: 3, cadence: "monthly" },
  { id: "m6", label: "6 months", installments: 6, cadence: "monthly" },
  { id: "m12", label: "12 months", installments: 12, cadence: "monthly" },
  { id: "m24", label: "24 months", installments: 24, cadence: "monthly" },
];

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
function attempt<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default function App({ today = localToday() }: { today?: string }) {
  const [presetId, setPresetId] = useState("m12");
  const [amount, setAmount] = useState("1,000.00");
  const [apr, setApr] = useState("10");
  const [firstDue, setFirstDue] = useState(today);

  const preset = PRESETS.find((p) => p.id === presetId)!;

  const plan = useMemo(
    () =>
      attempt(() =>
        buildPlan({
          principal: parseDollars(amount),
          aprBps: preset.interestFree ? 0 : parsePercentToBps(apr),
          installments: preset.installments,
          cadence: preset.cadence,
          firstDueDate: firstDue,
        }),
      ),
    [amount, apr, firstDue, preset],
  );

  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">installment-engine</p>
        <h1>Payment plan calculator</h1>
        <p className="lede">
          Every amount is a whole number of cents and every division is exact before one stated rounding. Totals always
          add up.
        </p>
      </header>

      <section className="card" aria-labelledby="terms-h">
        <h2 id="terms-h">Terms</h2>
        <div className="presets" role="radiogroup" aria-label="Plan length">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={p.id === presetId}
              className={p.id === presetId ? "chip on" : "chip"}
              onClick={() => setPresetId(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="fields">
          <label>
            Purchase amount ($)
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>
            APR (%)
            <input
              inputMode="decimal"
              value={preset.interestFree ? "0" : apr}
              disabled={preset.interestFree}
              onChange={(e) => setApr(e.target.value)}
            />
          </label>
          <label>
            {preset.interestFree ? "Purchase date (first payment)" : "First due date"}
            <input type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
          </label>
        </div>
      </section>

      {plan.ok ? (
        <PlanView key={presetId + amount + apr + firstDue} plan={plan.value} />
      ) : (
        <p className="error" role="alert">
          {plan.error}
        </p>
      )}

      <footer className="foot">
        A demo of an open-source calculation library. Not a credit offer, and not any lender's actual pricing.
      </footer>
    </main>
  );
}

function Summary({ plan }: { plan: Plan }) {
  const n = plan.installments.length;
  const last = plan.installments.at(-1)!.payment;
  return (
    <dl className="summary">
      <div>
        <dt>{plan.input.cadence === "biweekly" ? "Every 2 weeks" : "Per month"}</dt>
        <dd data-testid="regular">{formatCents(plan.regularPayment)}</dd>
      </div>
      <div>
        <dt>Payments</dt>
        <dd>
          {n}
          {last !== plan.regularPayment && <small> (last {formatCents(last)})</small>}
        </dd>
      </div>
      <div>
        <dt>Interest</dt>
        <dd data-testid="interest">{formatCents(plan.totalInterest)}</dd>
      </div>
      <div>
        <dt>Total</dt>
        <dd data-testid="total">{formatCents(plan.totalPaid)}</dd>
      </div>
    </dl>
  );
}

function Schedule({
  plan,
  before,
  paidCount,
  label = "Payment schedule",
}: {
  plan: Plan;
  before?: Plan;
  paidCount?: number;
  label?: string;
}) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={label}>
      <table>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Due</th>
            <th scope="col" className="num">
              Payment
            </th>
            <th scope="col" className="num">
              Interest
            </th>
            <th scope="col" className="num">
              Principal
            </th>
            <th scope="col" className="num">
              Balance
            </th>
          </tr>
        </thead>
        <tbody>
          {plan.installments.map((r, i) => {
            const was = before?.installments[i]?.payment;
            const changed = was !== undefined && was !== r.payment;
            const paid = paidCount !== undefined && i < paidCount;
            return (
              <tr key={r.number} className={paid ? "paid" : undefined}>
                <td>{r.number}</td>
                <td>{r.dueDate}</td>
                <td className="num">
                  {changed && <s className="was">{formatCents(was)}</s>} {formatCents(r.payment)}
                  {paid && <span className="tag">paid</span>}
                </td>
                <td className="num">{formatCents(r.interest)}</td>
                <td className="num">{formatCents(r.principal)}</td>
                <td className="num">{formatCents(r.balanceAfter)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PlanView({ plan }: { plan: Plan }) {
  const interestFree = plan.input.aprBps === 0;
  return (
    <>
      <section className="card" aria-labelledby="sched-h">
        <h2 id="sched-h">Schedule</h2>
        <Summary plan={plan} />
        <Schedule plan={plan} />
      </section>
      {interestFree ? <RefundSim plan={plan} /> : <Payoff plan={plan} />}
    </>
  );
}

function PaidSelect({ n, value, onChange }: { n: number; value: number; onChange: (v: number) => void }) {
  return (
    <label>
      Payments already made
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: n + 1 }, (_, k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
    </label>
  );
}

function RefundSim({ plan }: { plan: Plan }) {
  const [paid, setPaid] = useState(1);
  const [refund, setRefund] = useState("30.00");
  const result = attempt(() => applyRefund(plan, paid, parseDollars(refund)));
  return (
    <section className="card" aria-labelledby="refund-h">
      <h2 id="refund-h">Refund simulator</h2>
      <p className="hint">A merchant refund comes off the last payments first, so the next bill stays the same.</p>
      <div className="fields">
        <PaidSelect n={plan.installments.length} value={paid} onChange={setPaid} />
        <label>
          Refund ($)
          <input inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} />
        </label>
      </div>
      {result.ok ? (
        <>
          <p className="outcome" data-testid="cashback">
            Back to the customer now: <strong>{formatCents(result.value.cashBack)}</strong>
          </p>
          <Schedule plan={result.value.plan} before={plan} paidCount={paid} label="Schedule after refund" />
        </>
      ) : (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
    </section>
  );
}

function Payoff({ plan }: { plan: Plan }) {
  const [paid, setPaid] = useState(3);
  const n = plan.installments.length;
  const k = Math.min(paid, n);
  const quote = payoffQuote(plan, k);
  const remaining = plan.installments.slice(k).reduce((a, r) => a + r.payment, 0);
  return (
    <section className="card" aria-labelledby="payoff-h">
      <h2 id="payoff-h">Early payoff</h2>
      <p className="hint">Paying the remaining principal on a due date skips the interest still scheduled.</p>
      <div className="fields">
        <PaidSelect n={n} value={k} onChange={setPaid} />
      </div>
      <p className="outcome" data-testid="payoff">
        Pay <strong>{formatCents(quote)}</strong> to close the plan, saving{" "}
        <strong>{formatCents(remaining - quote)}</strong> of interest.
      </p>
    </section>
  );
}
