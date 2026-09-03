const PIVOT_HOUR = 11;

/** Get the Paper Hearts dayId (11 AM pivot) for a given date/time, or now. */
export function getDayId(date: Date = new Date()): string {
  const d = new Date(date);
  if (d.getHours() < PIVOT_HOUR) {
    d.setDate(d.getDate() - 1);
  }
  // Use local date parts — toISOString() returns UTC, which gives the wrong date
  // for users in non-UTC timezones (e.g. US users after ~11 AM get tomorrow's date).
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * How far back a background sync looks. The relay filters `day_id >= since`,
 * so syncing from today alone never returns an entry your partner wrote for an
 * earlier day — a late-night entry that lands after the pivot, or anything
 * written while you were offline, stays invisible.
 *
 * Matched to the relay's retention window (ENTRY_RETENTION_DAYS). A shorter
 * lookback would strand entries the relay is still holding: a second phone
 * left in a drawer for three weeks would come back and collect only the last
 * few days, and the rest would expire unseen.
 */
export const SYNC_LOOKBACK_DAYS = 30;

/** The dayId a background sync should fetch from. */
export function getSyncSince(date: Date = new Date()): string {
  const d = new Date(date);
  d.setDate(d.getDate() - SYNC_LOOKBACK_DAYS);
  return getDayId(d);
}

/** Format a dayId for display, e.g. "Monday, Feb 17" */
export function formatDayLabel(dayId: string): string {
  const d = new Date(dayId + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}
