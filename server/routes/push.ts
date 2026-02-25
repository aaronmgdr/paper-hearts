import sql from "../db";
import { verifyRequest, AuthError } from "../auth";
import { notifyPartner } from "../push";

/**
 * POST /api/push/subscribe
 * Authenticated. Register or update a push subscription for the current user.
 */
export async function subscribePush(req: Request, path: string): Promise<Response> {
  const bodyBytes = new Uint8Array(await req.clone().arrayBuffer());

  let auth;
  try {
    auth = await verifyRequest(req, path, bodyBytes);
  } catch (e) {
    if (e instanceof AuthError) {
      return Response.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const body = JSON.parse(new TextDecoder().decode(bodyBytes));
  const { endpoint, keys } = body;

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return Response.json({ error: "Invalid push subscription" }, { status: 400 });
  }

  console.log(`[subscribePush] user=${auth.publicKey.slice(0, 8)}… endpoint=${endpoint.slice(0, 40)}…`);

  await sql`
    UPDATE users
    SET push_endpoint = ${endpoint},
        push_p256dh = ${keys.p256dh},
        push_auth = ${keys.auth}
    WHERE public_key = ${auth.publicKey}
  `;

  return Response.json({ status: "subscribed" });
}

/**
 * POST /api/push/test
 * Authenticated. Sends a test push notification to the caller's partner
 * using the same notifyPartner path as entry submission.
 */
export async function testPush(req: Request, path: string): Promise<Response> {
  let auth;
  try {
    auth = await verifyRequest(req, path, null);
  } catch (e) {
    if (e instanceof AuthError) {
      return Response.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  notifyPartner(auth.publicKey, auth.pairId).catch((e) =>
    console.error("[testPush] push error:", e)
  );

  return Response.json({ ok: true });
}
