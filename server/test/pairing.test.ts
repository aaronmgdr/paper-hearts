import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer, stopServer } from "./setup";
import { generateKeyPair, post, createPair } from "./helpers";
import sodium from "libsodium-wrappers-sumo";
import {
  handleWsAuth,
  handleWsCollect,
  handleWsBundle,
  notifyPaired,
  removeWaiting,
  type WsData,
} from "../pairing";
import type { ServerWebSocket } from "bun";

await sodium.ready;

beforeAll(async () => { await startServer(); });
afterAll(async () => { await stopServer(); });

// ── Helpers ──────────────────────────────────────────────────

type MockWs = ServerWebSocket<WsData> & { _sent: string[]; _closed: boolean };

function mockWs(): MockWs {
  const ws = {
    data: { pairId: null, role: null } as WsData,
    _sent: [] as string[],
    _closed: false,
    send(msg: string) { this._sent.push(msg); },
    close() { this._closed = true; },
  };
  return ws as unknown as MockWs;
}

function lastMsg(ws: MockWs) {
  return JSON.parse(ws._sent[ws._sent.length - 1]);
}

function signWsMsg(prefix: string, pkB64: string, sk: Uint8Array) {
  const timestamp = new Date().toISOString();
  const payload = `${prefix}\n${pkB64}\n${timestamp}`;
  const sig = sodium.crypto_sign_detached(new TextEncoder().encode(payload), sk);
  return {
    publicKey: pkB64,
    timestamp,
    signature: sodium.to_base64(sig, sodium.base64_variants.ORIGINAL),
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("POST /api/pairs/join — partnerPublicKey in WS notification", () => {
  test("notifies initiator WS with follower's public key (not initiator's own key)", async () => {
    const initiator = generateKeyPair();
    const follower = generateKeyPair();

    const initRes = await post("/api/pairs/initiate", { publicKey: initiator.publicKey });
    expect(initRes.status).toBe(201);

    // Initiator opens a watch WS
    const watcherWs = mockWs();
    await handleWsAuth(watcherWs, signWsMsg("WATCH", initiator.publicKey, initiator.secretKey));
    expect(lastMsg(watcherWs).type).toBe("ready");

    // Follower joins via HTTP — triggers notifyPaired
    const joinRes = await post("/api/pairs/join", {
      publicKey: follower.publicKey,
      relayToken: initRes.data.relayToken,
    });
    expect(joinRes.status).toBe(200);

    // Watcher should have received "paired" with follower's key
    const pairedMsg = lastMsg(watcherWs);
    expect(pairedMsg.type).toBe("paired");
    expect(pairedMsg.partnerPublicKey).toBe(follower.publicKey);
    expect(pairedMsg.partnerPublicKey).not.toBe(initiator.publicKey);
  });
});

describe("removeWaiting", () => {
  test("removing collector does not evict watcher from waiting map", async () => {
    const { initiator, follower } = await createPair();

    // Register watcher
    const watcherWs = mockWs();
    await handleWsAuth(watcherWs, signWsMsg("WATCH", initiator.publicKey, initiator.secretKey));
    expect(lastMsg(watcherWs).type).toBe("ready");

    // Register collector
    const collectorWs = mockWs();
    await handleWsCollect(collectorWs, signWsMsg("COLLECT", follower.publicKey, follower.secretKey));
    expect(lastMsg(collectorWs).type).toBe("ready");

    // Collector disconnects
    removeWaiting(collectorWs);

    // Watcher should still be registered — notifyPaired should still reach it
    notifyPaired(watcherWs.data.pairId!, "some-key");
    const pairedMsg = lastMsg(watcherWs);
    expect(pairedMsg.type).toBe("paired");
  });

  test("removing watcher does not affect collectors map", async () => {
    const { initiator, follower } = await createPair();

    const watcherWs = mockWs();
    await handleWsAuth(watcherWs, signWsMsg("WATCH", initiator.publicKey, initiator.secretKey));

    const collectorWs = mockWs();
    await handleWsCollect(collectorWs, signWsMsg("COLLECT", follower.publicKey, follower.secretKey));

    // Watcher disconnects
    removeWaiting(watcherWs);

    // Send bundle — no watcher in map now, but collector still exists; bundle is buffered then collector gets it
    // (collector is still open — verify it wasn't affected)
    expect(collectorWs._closed).toBe(false);
  });
});

describe("handleWsBundle", () => {
  test("relays bundle live to connected collector", async () => {
    const { initiator, follower } = await createPair();

    const watcherWs = mockWs();
    await handleWsAuth(watcherWs, signWsMsg("WATCH", initiator.publicKey, initiator.secretKey));

    const collectorWs = mockWs();
    await handleWsCollect(collectorWs, signWsMsg("COLLECT", follower.publicKey, follower.secretKey));

    handleWsBundle(watcherWs, "encrypted-bundle-payload");

    const bundleMsg = lastMsg(collectorWs);
    expect(bundleMsg.type).toBe("bundle");
    expect(bundleMsg.payload).toBe("encrypted-bundle-payload");

    expect(watcherWs._closed).toBe(true);
    expect(collectorWs._closed).toBe(true);
  });

  test("buffers bundle when no collector is connected", async () => {
    const { initiator, follower } = await createPair();

    const watcherWs = mockWs();
    await handleWsAuth(watcherWs, signWsMsg("WATCH", initiator.publicKey, initiator.secretKey));

    // No collector yet — bundle gets buffered
    handleWsBundle(watcherWs, "buffered-payload");
    expect(watcherWs._closed).toBe(true);

    // Collector connects after the fact — should receive buffered bundle immediately
    const collectorWs = mockWs();
    await handleWsCollect(collectorWs, signWsMsg("COLLECT", follower.publicKey, follower.secretKey));

    const bundleMsg = lastMsg(collectorWs);
    expect(bundleMsg.type).toBe("bundle");
    expect(bundleMsg.payload).toBe("buffered-payload");
    expect(collectorWs._closed).toBe(true);
  });
});

describe("handleWsCollect", () => {
  test("sends ready when no buffered bundle exists", async () => {
    const { follower } = await createPair();

    const collectorWs = mockWs();
    await handleWsCollect(collectorWs, signWsMsg("COLLECT", follower.publicKey, follower.secretKey));

    expect(lastMsg(collectorWs).type).toBe("ready");
    expect(collectorWs._closed).toBe(false);
  });

  test("rejects auth with wrong prefix", async () => {
    const { follower } = await createPair();

    const collectorWs = mockWs();
    // Sign with wrong prefix (WATCH instead of COLLECT)
    await handleWsCollect(collectorWs, signWsMsg("WATCH", follower.publicKey, follower.secretKey));

    const errMsg = lastMsg(collectorWs);
    expect(errMsg.type).toBe("error");
    expect(collectorWs._closed).toBe(true);
  });
});

describe("handleWsAuth", () => {
  test("rejects expired timestamp", async () => {
    const initiator = generateKeyPair();
    await post("/api/pairs/initiate", { publicKey: initiator.publicKey });

    const ws = mockWs();
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const payload = `WATCH\n${initiator.publicKey}\n${oldTimestamp}`;
    const sig = sodium.crypto_sign_detached(new TextEncoder().encode(payload), initiator.secretKey);

    await handleWsAuth(ws, {
      publicKey: initiator.publicKey,
      timestamp: oldTimestamp,
      signature: sodium.to_base64(sig, sodium.base64_variants.ORIGINAL),
    });

    const errMsg = lastMsg(ws);
    expect(errMsg.type).toBe("error");
    expect(errMsg.message).toContain("expired");
    expect(ws._closed).toBe(true);
  });

  test("rejects unknown user", async () => {
    const stranger = generateKeyPair(); // not in DB

    const ws = mockWs();
    await handleWsAuth(ws, signWsMsg("WATCH", stranger.publicKey, stranger.secretKey));

    const errMsg = lastMsg(ws);
    expect(errMsg.type).toBe("error");
    expect(errMsg.message).toContain("Unknown");
    expect(ws._closed).toBe(true);
  });
});
