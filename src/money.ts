/**
 * Money is always an integer number of cents. Floats never touch an amount:
 * parsing is done on the string, and any division goes through bigint with an
 * explicit rounding rule.
 */
export type Cents = number;

export class MoneyError extends Error {
  override name = "MoneyError";
}

export function assertCents(value: number, label = "amount"): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a whole number of cents, got ${value}`);
  }
}

const DOLLARS = /^\s*(-)?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*$/;

/** "1,234.5" -> 123450. Rejects more than two decimals instead of rounding silently. */
export function parseDollars(input: string): Cents {
  const m = DOLLARS.exec(input);
  if (!m) throw new MoneyError(`Not a dollar amount: "${input}"`);
  const whole = BigInt(m[2]!.replaceAll(",", ""));
  const frac = BigInt((m[3] ?? "").padEnd(2, "0"));
  const cents = whole * 100n + frac;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError(`Amount too large: "${input}"`);
  return m[1] && cents > 0n ? -Number(cents) : Number(cents);
}

/** 123450 -> "$1,234.50" */
export function formatCents(cents: Cents): string {
  assertCents(cents);
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${cents < 0 ? "-" : ""}$${whole}.${frac}`;
}

/** num / den rounded half to even (banker's rounding). den must be positive. */
export function divHalfEven(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new MoneyError("denominator must be positive");
  if (num < 0n) return -divHalfEven(-num, den);
  const q = num / den;
  const twice = (num % den) * 2n;
  if (twice > den) return q + 1n;
  if (twice === den) return q % 2n === 0n ? q : q + 1n;
  return q;
}

/** num / den rounded up (toward +infinity) for num >= 0. */
export function divCeil(num: bigint, den: bigint): bigint {
  if (den <= 0n || num < 0n) throw new MoneyError("divCeil expects num >= 0 and den > 0");
  return (num + den - 1n) / den;
}

/**
 * Split `total` into `parts` amounts that sum exactly to `total` and differ by
 * at most one cent. Extra cents go to the earliest parts.
 */
export function splitEvenly(total: Cents, parts: number): Cents[] {
  assertCents(total, "total");
  if (total < 0) throw new MoneyError("total must not be negative");
  if (!Number.isSafeInteger(parts) || parts < 1) throw new MoneyError("parts must be a positive integer");
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Proportional allocation by the largest-remainder method: every share is
 * within one cent of its exact value and the shares sum exactly to `total`.
 * Ties on the remainder go to the earlier index, so the result is deterministic.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total, "total");
  if (total < 0) throw new MoneyError("total must not be negative");
  if (weights.length === 0) throw new MoneyError("weights must not be empty");
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) throw new MoneyError("weights must be non-negative integers");
  }
  const sum = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (sum === 0n) throw new MoneyError("weights must not all be zero");

  const T = BigInt(total);
  const floors = weights.map((w) => (T * BigInt(w)) / sum);
  const remainders = weights.map((w, i) => ({ i, r: (T * BigInt(w)) % sum }));
  let left = Number(T - floors.reduce((a, f) => a + f, 0n));
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = floors.map(Number);
  for (const { i } of remainders) {
    if (left === 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

const PERCENT = /^\s*(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/;

/** "29.99" or "29.99%" -> 2999 basis points. */
export function parsePercentToBps(input: string): number {
  const m = PERCENT.exec(input);
  if (!m) throw new MoneyError(`Not a percentage: "${input}"`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
