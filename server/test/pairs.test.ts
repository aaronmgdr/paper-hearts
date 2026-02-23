import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer, stopServer } from "./setup";
import { generateKeyPair, post, createPair, todayDayId, authPost } from "./helpers";

beforeAll(async () => {
  await startServer();
});

afterAll(async () => {
  await stopServer();
});

describe("POST /api/pairs/initiate", () => {
  test("creates a pair with a valid Ed25519 public key", async () => {
    const { publicKey } = generateKeyPair();
    const { status, data } = await post("/api/pairs/initiate", { publicKey });

    expect(status).toBe(201);
    expect(data.pairId).toBeDefined();
    expect(data.relayToken).toBeDefined();
    expect(typeof data.relayToken).toBe("string");
  });

  test("rejects missing publicKey", async () => {
    const { status, data } = await post("/api/pairs/initiate", {});
    expect(status).toBe(400);
    expect(data.error).toContain("publicKey");
  });

  test("rejects invalid base64", async () => {
    const { status } = await post("/api/pairs/initiate", {
      publicKey: "not-valid-base64!!!",
    });
    expect(status).toBe(400);
  });

  test("rejects wrong-length key", async () => {
    const { status, data } = await post("/api/pairs/initiate", {
      publicKey: "AAAA",
    });
    expect(status).toBe(400);
    expect(data.error).toContain("length");
  });

  test("re-pairing succeeds and creates a new pair", async () => {
    const { publicKey } = generateKeyPair();
    const res1 = await post("/api/pairs/initiate", { publicKey });
    expect(res1.status).toBe(201);

    const res2 = await post("/api/pairs/initiate", { publicKey });
    expect(res2.status).toBe(201);
    expect(res2.data.pairId).not.toBe(res1.data.pairId);
  });
});

describe("POST /api/pairs/join", () => {
  test("joins a pair with a valid relay token", async () => {
    const initiator = generateKeyPair();
    const follower = generateKeyPair();

    const initRes = await post("/api/pairs/initiate", {
      publicKey: initiator.publicKey,
    });
    expect(initRes.status).toBe(201);

    const { status, data } = await post("/api/pairs/join", {
      publicKey: follower.publicKey,
      relayToken: initRes.data.relayToken,
    });

    expect(status).toBe(200);
    expect(data.pairId).toBe(initRes.data.pairId);
    expect(data.partnerPublicKey).toBe(initiator.publicKey);
  });

  test("rejects invalid relay token", async () => {
    const { publicKey } = generateKeyPair();
    const { status } = await post("/api/pairs/join", {
      publicKey,
      relayToken: "nonexistent-token",
    });

    expect(status).toBe(404);
  });

  test("rejects already consumed token", async () => {
    const initiator = generateKeyPair();
    const follower1 = generateKeyPair();
    const follower2 = generateKeyPair();

    const initRes = await post("/api/pairs/initiate", {
      publicKey: initiator.publicKey,
    });

    await post("/api/pairs/join", {
      publicKey: follower1.publicKey,
      relayToken: initRes.data.relayToken,
    });

    const { status, data } = await post("/api/pairs/join", {
      publicKey: follower2.publicKey,
      relayToken: initRes.data.relayToken,
    });

    expect(status).toBe(410);
    expect(data.error).toContain("consumed");
  });

  test("rejects joining your own pair", async () => {
    const initiator = generateKeyPair();

    const initRes = await post("/api/pairs/initiate", {
      publicKey: initiator.publicKey,
    });

    const { status, data } = await post("/api/pairs/join", {
      publicKey: initiator.publicKey,
      relayToken: initRes.data.relayToken,
    });

    expect(status).toBe(400);
    expect(data.error).toContain("own pair");
  });

  test("rejects missing fields", async () => {
    const res1 = await post("/api/pairs/join", { publicKey: "abc" });
    expect(res1.status).toBe(400);

    const res2 = await post("/api/pairs/join", { relayToken: "abc" });
    expect(res2.status).toBe(400);
  });
});

describe("re-pairing", () => {
  test("initiator can re-pair after having written entries", async () => {
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();

    // Write an entry under the original pair
    const writeRes = await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("old entry").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(writeRes.status).toBe(201);

    // Initiator re-pairs — should not crash with FK violation
    const reInitRes = await post("/api/pairs/initiate", {
      publicKey: initiator.publicKey,
    });
    expect(reInitRes.status).toBe(201);
    expect(reInitRes.data.pairId).toBeDefined();

    // Follower joins the new pair
    const reJoinRes = await post("/api/pairs/join", {
      publicKey: follower.publicKey,
      relayToken: reInitRes.data.relayToken,
    });
    expect(reJoinRes.status).toBe(200);
    expect(reJoinRes.data.pairId).toBe(reInitRes.data.pairId);
  });

  test("follower can re-pair after having written entries", async () => {
    const { initiator, follower } = await createPair();
    const dayId = todayDayId();

    // Follower writes an entry
    const writeRes = await authPost(
      "/api/entries",
      { dayId, payload: Buffer.from("follower entry").toString("base64") },
      follower.publicKey,
      follower.secretKey
    );
    expect(writeRes.status).toBe(201);

    // New pair initiated by initiator
    const reInitRes = await post("/api/pairs/initiate", {
      publicKey: initiator.publicKey,
    });
    expect(reInitRes.status).toBe(201);

    // Follower re-joins — should not crash with FK violation
    const reJoinRes = await post("/api/pairs/join", {
      publicKey: follower.publicKey,
      relayToken: reInitRes.data.relayToken,
    });
    expect(reJoinRes.status).toBe(200);
  });
});
