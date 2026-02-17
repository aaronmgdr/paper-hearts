import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer, stopServer } from "./setup";
import { generateKeyPair, createPair, todayDayId, post, authPost, authGet } from "./helpers";

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

  test("enforces rate limit of 2 per day", async () => {
    const { initiator } = await createPair();
    const dayId = todayDayId();
    const payload = Buffer.from("test").toString("base64");

    const res1 = await authPost(
      "/api/entries",
      { dayId, payload },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(res1.status).toBe(201);

    const res2 = await authPost(
      "/api/entries",
      { dayId, payload },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(res2.status).toBe(201);

    const res3 = await authPost(
      "/api/entries",
      { dayId, payload },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(res3.status).toBe(429);
    expect(res3.data.error).toContain("Rate limit");
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
  });

  test("does not return own entries", async () => {
    const { initiator } = await createPair();
    const dayId = todayDayId();

    await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("mine").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );

    const { data } = await authGet(
      `/api/entries?since=${dayId}`,
      initiator.publicKey,
      initiator.secretKey
    );

    expect(data.entries).toHaveLength(0);
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
  test("acknowledges and deletes entries", async () => {
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
    expect(ackRes.data.deleted).toBe(1);

    const fetchRes2 = await authGet(
      `/api/entries?since=${dayId}`,
      follower.publicKey,
      follower.secretKey
    );
    expect(fetchRes2.data.entries).toHaveLength(0);
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

    expect(ackRes.data.deleted).toBe(0);
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
