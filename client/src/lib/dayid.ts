const PIVOT_HOUR = 4;

/** Get the Paper Hearts dayId (4 AM pivot) for a given date/time, or now. */
export function getDayId(date: Date = new Date()): string {
  const d = new Date(date);
  if (d.getHours() < PIVOT_HOUR) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
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
