import sql from "./db";

/**
 * How long an encrypted blob stays on the relay after it is written.
 *
 * Entries used to be deleted the instant the recipient acknowledged them. That
 * makes a second device on the same account unworkable — whichever phone polls
 * first destroys the blob before the other one has collected it. Acknowledging
 * now only marks the row; a fixed window decides when it goes.
 *
 * This is a deliberate amendment to the delete-on-ack retention promise in the
 * PRD: an encrypted blob the relay cannot read now lingers for the window
 * instead of vanishing on ack. The window only has to outlast "my other phone
 * hasn't been opened in a while" — losing every device is what the recovery
 * backup is for, not this.
 */
export const ENTRY_RETENTION_DAYS = 30;

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Delete entries past the retention window. Returns how many went. */
export async function sweepExpiredEntries(): Promise<number> {
  const deleted = await sql`
    DELETE FROM entries
    WHERE created_at < now() - make_interval(days => ${ENTRY_RETENTION_DAYS})
    RETURNING id
  `;
  if (deleted.length > 0) {
    console.log(`[retention] swept ${deleted.length} expired entries`);
  }
  return deleted.length;
}

/** Run the sweep now and every six hours after. */
export function startRetentionSweep(): void {
  const run = () =>
    sweepExpiredEntries().catch((e) => console.error("[retention] sweep failed:", e));
  run();
  setInterval(run, SWEEP_INTERVAL_MS);
}
