import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer, stopServer } from "./setup";
import { generateKeyPair, post } from "./helpers";

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

  test("rejects duplicate public key", async () => {
    const { publicKey } = generateKeyPair();
    await post("/api/pairs/initiate", { publicKey });
    const { status, data } = await post("/api/pairs/initiate", { publicKey });

    expect(status).toBe(409);
    expect(data.error).toContain("already registered");
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
