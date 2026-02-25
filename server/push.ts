import webpush from "web-push";
import sql from "./db";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:paper@example.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

/**
 * Send a push notification to a user's partner.
 * Fire-and-forget — errors are logged but don't propagate.
 */
export async function notifyPartner(authorKey: string, pairId: string): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log("[push] VAPID keys not configured, skipping");
    return;
  }

  const partners = await sql`
    SELECT public_key, push_endpoint, push_p256dh, push_auth
    FROM users
    WHERE pair_id = ${pairId}
      AND public_key != ${authorKey}
      AND push_endpoint IS NOT NULL
  `;

  if (partners.length === 0) {
    console.log("[push] no partner subscription found");
    return;
  }

  const partner = partners[0];
  const subscription = {
    endpoint: partner.push_endpoint,
    keys: {
      p256dh: partner.push_p256dh,
      auth: partner.push_auth,
    },
  };

  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({ type: "partner-entry" })
    );
    console.log(`[push] sent to ${partner.public_key.slice(0, 8)}…`);
  } catch (e: any) {
    console.error(`[push] failed for ${partner.public_key.slice(0, 8)}…:`, e.statusCode || e.message);
    // 410 Gone = subscription expired, clean it up
    if (e.statusCode === 410) {
      await sql`
        UPDATE users
        SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL
        WHERE public_key = ${partner.public_key}
      `;
      console.log(`[push] cleared stale subscription for ${partner.public_key.slice(0, 8)}…`);
    }
  }
}
