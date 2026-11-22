/**
 * Calendar dates as "YYYY-MM-DD" strings, computed in UTC so a due date never
 * shifts because of the machine's time zone or a DST change.
 */
export type IsoDate = string;

export class DateError extends Error {
  override name = "DateError";
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: IsoDate): [number, number, number] {
  const m = ISO.exec(date);
  if (!m) throw new DateError(`Expected YYYY-MM-DD, got "${date}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
    throw new DateError(`Not a real calendar date: "${date}"`);
  }
  return [y, mo, d];
}

export function assertIsoDate(date: IsoDate): void {
  parts(date);
}

/** month is 1-12 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function fmt(y: number, mo: number, d: number): IsoDate {
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, mo, d] = parts(date);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * Add calendar months, clamping to the last day of a short month. Always
 * computed from the original anchor, so Jan 31 gives Feb 28/29, then Mar 31
 * (not Mar 28, which is what chaining "add one month" would drift to).
 */
export function addMonthsClamped(anchor: IsoDate, months: number): IsoDate {
  const [y, mo, d] = parts(anchor);
  const index = y * 12 + (mo - 1) + months;
  const ny = Math.floor(index / 12);
  const nmo = (index % 12) + 1;
  return fmt(ny, nmo, Math.min(d, daysInMonth(ny, nmo)));
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
