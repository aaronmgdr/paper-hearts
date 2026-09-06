import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer, stopServer } from "./setup";
import { generateKeyPair, createPair, todayDayId, post, authPost, authGet } from "./helpers";
import sql from "../db";
import { sweepExpiredEntries } from "../retention";

beforeAll(async () => {
  await startServer();
});

afterAll(async () => {
  await stopServer();
});

describe("POST /api/entries", () => {
  test("stores an encrypted entry", async () => {
    const { initiator } = await createPair();
    const dayId = todayDayId();

    const { status, data } = await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("encrypted-content").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );

    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.status).toBe("stored");
  });

  test("rejects unauthenticated request", async () => {
    const { status } = await post("/api/entries", {
      dayId: todayDayId(),
      payload: "abc",
    });

    expect(status).toBe(401);
  });

  test("rejects invalid dayId format", async () => {
    const { initiator } = await createPair();

    const { status, data } = await authPost(
      "/api/entries",
      { dayId: "not-a-date", payload: "abc" },
      initiator.publicKey,
      initiator.secretKey
    );

    expect(status).toBe(400);
    expect(data.error).toContain("YYYY-MM-DD");
  });

  test("upserts on second submission for the same day (one entry per day)", async () => {
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();

    const res1 = await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("first version").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(res1.status).toBe(201);
    const firstId = res1.data.id;

    const res2 = await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("updated version").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(res2.status).toBe(201);
    // Upsert returns the same row id
    expect(res2.data.id).toBe(firstId);

    // Follower receives the updated payload, not the original
    const fetchRes = await authGet(
      `/api/entries?since=${dayId}`,
      follower.publicKey,
      follower.secretKey
    );
    expect(fetchRes.data.entries).toHaveLength(1);
    expect(fetchRes.data.entries[0].payload).toBe(
      Buffer.from("updated version").toString("base64")
    );
  });

  test("edit after ack re-queues the entry for partner", async () => {
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();

    // Initiator writes, follower fetches and acks
    await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("original").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );
    const fetchRes1 = await authGet(`/api/entries?since=${dayId}`, follower.publicKey, follower.secretKey);
    await authPost("/api/entries/ack", { entryIds: [fetchRes1.data.entries[0].id] }, follower.publicKey, follower.secretKey);

    // Initiator edits (upsert resets acked_at)
    await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("edited").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );

    // Follower can now fetch the updated entry
    const fetchRes2 = await authGet(`/api/entries?since=${dayId}`, follower.publicKey, follower.secretKey);
    expect(fetchRes2.data.entries).toHaveLength(1);
    expect(fetchRes2.data.entries[0].payload).toBe(Buffer.from("edited").toString("base64"));
  });

  test("rejects unknown public key", async () => {
    const rando = generateKeyPair();

    const { status, data } = await authPost(
      "/api/entries",
      { dayId: todayDayId(), payload: Buffer.from("test").toString("base64") },
      rando.publicKey,
      rando.secretKey
    );

    expect(status).toBe(401);
    expect(data.error).toContain("Unknown public key");
  });
});

describe("GET /api/entries", () => {
  test("fetches partner's entries", async () => {
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();
    const payload = Buffer.from("hello-from-initiator").toString("base64");

    await authPost(
      "/api/entries",
      { dayId, payload },
      initiator.publicKey,
      initiator.secretKey
    );

    const { status, data } = await authGet(
      `/api/entries?since=${dayId}`,
      follower.publicKey,
      follower.secretKey
    );

    expect(status).toBe(200);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].dayId).toBe(dayId);
    expect(data.entries[0].payload).toBe(payload);
    expect(data.entries[0].author).toBe("partner");
  });

  test("omits own entries unless the client asks for scope=all", async () => {
    // A client from before the label existed files every returned row in the
    // partner slot. On a day where only you had written, your own blob would
    // come back and show up as your partner's, lifting the veil on nothing.
    // The service worker keeps such a client alive for at least one session
    // after a deploy, so partner-only stays the default.
    const { initiator } = await createPair();
    const dayId = todayDayId();

    await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("mine").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );

    const legacy = await authGet(
      `/api/entries?since=${dayId}`,
      initiator.publicKey,
      initiator.secretKey
    );
    expect(legacy.data.entries).toHaveLength(0);

    const modern = await authGet(
      `/api/entries?since=${dayId}&scope=all`,
      initiator.publicKey,
      initiator.secretKey
    );
    expect(modern.data.entries).toHaveLength(1);
    expect(modern.data.entries[0].author).toBe("me");
  });

  test("returns own entries so a second phone on this account can collect them", async () => {
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();
    const mine = Buffer.from("written on phone A").toString("base64");
    const theirs = Buffer.from("written by partner").toString("base64");

    await authPost("/api/entries", { dayId, payload: mine }, initiator.publicKey, initiator.secretKey);
    await authPost("/api/entries", { dayId, payload: theirs }, follower.publicKey, follower.secretKey);

    const { status, data } = await authGet(
      `/api/entries?since=${dayId}&scope=all`,
      initiator.publicKey,
      initiator.secretKey
    );

    expect(status).toBe(200);
    expect(data.entries).toHaveLength(2);
    const byAuthor = Object.fromEntries(data.entries.map((e: { author: string; payload: string }) => [e.author, e.payload]));
    expect(byAuthor.me).toBe(mine);
    expect(byAuthor.partner).toBe(theirs);

    const asFollower = await authGet(
      `/api/entries?since=${dayId}&scope=all`,
      follower.publicKey,
      follower.secretKey
    );
    const followerView = Object.fromEntries(
      asFollower.data.entries.map((e: { author: string; payload: string }) => [e.author, e.payload])
    );
    expect(followerView.me).toBe(theirs);
    expect(followerView.partner).toBe(mine);
  });

  test("changedSince narrows the reply to what has actually moved", async () => {
    // Without this the foreground poll re-sends the whole retention window
    // every 30 seconds.
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();

    await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("first").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );

    const first = await authGet(
      `/api/entries?since=1970-01-01&scope=all`,
      follower.publicKey,
      follower.secretKey
    );
    expect(first.data.entries).toHaveLength(1);
    const cursor = first.data.nextChangedSince as string;
    expect(cursor).toBeDefined();

    // Nothing has changed, but the cursor is rewound for safety, so the reply
    // is allowed to repeat that entry — it must not grow beyond it.
    const repeat = await authGet(
      `/api/entries?since=1970-01-01&scope=all&changedSince=${encodeURIComponent(
        new Date(Date.now() + 60_000).toISOString()
      )}`,
      follower.publicKey,
      follower.secretKey
    );
    expect(repeat.data.entries).toHaveLength(0);

    // An edit moves updated_at, so a day already delivered comes back.
    await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("edited").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );
    const afterEdit = await authGet(
      `/api/entries?since=1970-01-01&scope=all&changedSince=${encodeURIComponent(cursor)}`,
      follower.publicKey,
      follower.secretKey
    );
    expect(afterEdit.data.entries).toHaveLength(1);
    expect(afterEdit.data.entries[0].payload).toBe(Buffer.from("edited").toString("base64"));
  });

  test("an unusable cursor falls back to the full window", async () => {
    // Treating a bad cursor as "up to date" would strand the device silently.
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();

    await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("hello").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );

    const { data } = await authGet(
      `/api/entries?since=1970-01-01&scope=all&changedSince=not-a-date`,
      follower.publicKey,
      follower.secretKey
    );
    expect(data.entries).toHaveLength(1);
  });

  test("an edited entry stays collectable for 30 days from the edit", async () => {
    // Retention used to key off created_at alone, so a day written a month
    // ago and edited yesterday vanished from a second phone that hadn't opened.
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();

    await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("original").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );
    await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("edited").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );
    await sql`
      UPDATE entries
      SET created_at = now() - interval '31 days',
          updated_at = now()
      WHERE author_key = ${initiator.publicKey} AND day_id = ${dayId}
    `;

    const stillThere = await authGet(
      `/api/entries?since=1970-01-01`,
      follower.publicKey,
      follower.secretKey
    );
    expect(stillThere.data.entries).toHaveLength(1);
    expect(stillThere.data.entries[0].payload).toBe(Buffer.from("edited").toString("base64"));

    expect(await sweepExpiredEntries()).toBe(0);
  });

  test("returns empty array when no entries", async () => {
    const { follower } = await createPair();

    const { status, data } = await authGet(
      `/api/entries?since=2020-01-01`,
      follower.publicKey,
      follower.secretKey
    );

    expect(status).toBe(200);
    expect(data.entries).toHaveLength(0);
  });
});

describe("POST /api/entries/ack", () => {
  test("acknowledges an entry and leaves it collectable", async () => {
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();

    await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("ack-me").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );

    const fetchRes = await authGet(
      `/api/entries?since=${dayId}`,
      follower.publicKey,
      follower.secretKey
    );
    expect(fetchRes.data.entries).toHaveLength(1);

    const entryId = fetchRes.data.entries[0].id;

    const ackRes = await authPost(
      "/api/entries/ack",
      { entryIds: [entryId] },
      follower.publicKey,
      follower.secretKey
    );

    expect(ackRes.status).toBe(200);
    expect(ackRes.data.acknowledged).toBe(1);

    // Acknowledging marks the row rather than destroying it. Deleting here
    // would make a second phone on the same account impossible — whichever
    // device polled first would take the entry away from the other.
    const fetchRes2 = await authGet(
      `/api/entries?since=${dayId}`,
      follower.publicKey,
      follower.secretKey
    );
    expect(fetchRes2.data.entries).toHaveLength(1);
    expect(fetchRes2.data.entries[0].id).toBe(entryId);

    // Acking twice is a no-op.
    const ackAgain = await authPost(
      "/api/entries/ack",
      { entryIds: [entryId] },
      follower.publicKey,
      follower.secretKey
    );
    expect(ackAgain.data.acknowledged).toBe(0);
  });

  test("cannot ack own entries", async () => {
    const { initiator } = await createPair();
    const dayId = todayDayId();

    const writeRes = await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("no-self-ack").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );

    const ackRes = await authPost(
      "/api/entries/ack",
      { entryIds: [writeRes.data.id] },
      initiator.publicKey,
      initiator.secretKey
    );

    expect(ackRes.data.acknowledged).toBe(0);
  });

  test("rejects empty entryIds", async () => {
    const { follower } = await createPair();

    const { status } = await authPost(
      "/api/entries/ack",
      { entryIds: [] },
      follower.publicKey,
      follower.secretKey
    );

    expect(status).toBe(400);
  });
});
