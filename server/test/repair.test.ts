import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer, stopServer } from "./setup";
import sql from "../db";
import {
  generateKeyPair,
  post,
  authPost,
  authGet,
  createPair,
  todayDayId,
} from "./helpers";

beforeAll(async () => {
  await startServer();
});

afterAll(async () => {
  await stopServer();
});

const blob = (s: string) => Buffer.from(s).toString("base64");

/** What the partner can currently see, oldest day first. */
async function inbox(publicKey: string, secretKey: Uint8Array) {
  const { data } = await authGet("/api/entries?since=1970-01-01", publicKey, secretKey);
  return (data.entries ?? []) as Array<{ id: string; dayId: string; payload: string }>;
}

describe("pairing survives a re-link", () => {
  test("a superseded pairing code is rejected instead of orphaning both sides", async () => {
    // Generating a code twice — backing out of the QR screen and retrying is
    // the common way this happens — used to leave the first code pointing at a
    // pair the initiator had already left. Redeeming it put the two people in
    // different pairs while both devices displayed "linked".
    const initiator = generateKeyPair();
    const follower = generateKeyPair();

    const first = await post("/api/pairs/initiate", { publicKey: initiator.publicKey });
    const second = await post("/api/pairs/initiate", { publicKey: initiator.publicKey });
    expect(second.data.pairId).not.toBe(first.data.pairId);

    const stale = await post("/api/pairs/join", {
      publicKey: follower.publicKey,
      relayToken: first.data.relayToken,
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);

    // The current code still works.
    const fresh = await post("/api/pairs/join", {
      publicKey: follower.publicKey,
      relayToken: second.data.relayToken,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.data.pairId).toBe(second.data.pairId);
  });

  test("join follows the initiator's current pair, not the pair on the token", async () => {
    // Defence in depth for a token issued before codes were invalidated on
    // re-initiate. The token's pair_id is stale; the join must still land both
    // people in the pair the initiator actually occupies.
    const initiator = generateKeyPair();
    const follower = generateKeyPair();

    const res = await post("/api/pairs/initiate", { publicKey: initiator.publicKey });
    const currentPairId = res.data.pairId;

    const [orphan] = await sql`INSERT INTO pairs DEFAULT VALUES RETURNING id`;
    await sql`
      UPDATE relay_tokens SET pair_id = ${orphan.id} WHERE token = ${res.data.relayToken}
    `;

    const join = await post("/api/pairs/join", {
      publicKey: follower.publicKey,
      relayToken: res.data.relayToken,
    });

    expect(join.status).toBe(200);
    expect(join.data.pairId).toBe(currentPairId);

    const members = await sql`SELECT public_key FROM users WHERE pair_id = ${currentPairId}`;
    expect(members.map((m) => m.public_key).sort()).toEqual(
      [initiator.publicKey, follower.publicKey].sort()
    );

    // And the two can actually exchange an entry.
    const dayId = todayDayId();
    await authPost("/api/entries", { dayId, payload: blob("hello") }, initiator.publicKey, initiator.secretKey);
    expect(await inbox(follower.publicKey, follower.secretKey)).toHaveLength(1);
  });

  test("re-linking clears entries stranded in the abandoned pair", async () => {
    // Blobs left in the old pair were encrypted under the old shared secret, so
    // the new partner's decrypt throws, the id never reaches the ack list, and
    // the blob is re-fetched forever. They are dropped at re-link instead.
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();

    await authPost("/api/entries", { dayId, payload: blob("old") }, initiator.publicKey, initiator.secretKey);
    expect(await inbox(follower.publicKey, follower.secretKey)).toHaveLength(1);

    const newFollower = generateKeyPair();
    const re = await post("/api/pairs/initiate", { publicKey: initiator.publicKey });
    await post("/api/pairs/join", {
      publicKey: newFollower.publicKey,
      relayToken: re.data.relayToken,
    });

    expect(await inbox(newFollower.publicKey, newFollower.secretKey)).toHaveLength(0);

    // The initiator can write that same day again and it reaches the new partner.
    await authPost("/api/entries", { dayId, payload: blob("new") }, initiator.publicKey, initiator.secretKey);
    const received = await inbox(newFollower.publicKey, newFollower.secretKey);
    expect(received).toHaveLength(1);
    expect(Buffer.from(received[0].payload, "base64").toString()).toBe("new");
  });

  test("rewriting a day repairs a row left behind in an old pair", async () => {
    // entries is unique on (author_key, day_id), so a leftover row absorbs every
    // rewrite of that day. The upsert used to leave pair_id untouched, which
    // meant the entry stayed filed under a pair getEntries never looks at —
    // invisible to the partner no matter how many times it was rewritten.
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();

    await authPost("/api/entries", { dayId, payload: blob("first") }, initiator.publicKey, initiator.secretKey);

    const [orphan] = await sql`INSERT INTO pairs DEFAULT VALUES RETURNING id`;
    await sql`
      UPDATE entries SET pair_id = ${orphan.id}
      WHERE author_key = ${initiator.publicKey} AND day_id = ${dayId}
    `;
    expect(await inbox(follower.publicKey, follower.secretKey)).toHaveLength(0);

    await authPost("/api/entries", { dayId, payload: blob("rewritten") }, initiator.publicKey, initiator.secretKey);

    const received = await inbox(follower.publicKey, follower.secretKey);
    expect(received).toHaveLength(1);
    expect(Buffer.from(received[0].payload, "base64").toString()).toBe("rewritten");
  });
});
