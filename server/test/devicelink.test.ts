import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import sodium from "libsodium-wrappers-sumo";
import { startServer, stopServer } from "./setup";
import { post, authPost, authPostEmpty, authGet, anonGet, createPair } from "./helpers";

beforeAll(async () => {
  await startServer();
  await sodium.ready;
});

afterAll(async () => {
  await stopServer();
});

const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL);

function ephemeralKeys() {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: b64(kp.publicKey), raw: kp };
}

async function openMailbox(owner: { publicKey: string; secretKey: Uint8Array }) {
  const start = await authPostEmpty("/api/device-link/start", owner.publicKey, owner.secretKey);
  expect(start.status).toBe(201);
  return start.data.token as string;
}

describe("device link", () => {
  test("carries a sealed bundle from one device to another", async () => {
    const { initiator } = await createPair();
    const token = await openMailbox(initiator);

    // Nothing to poll for until the new device joins.
    const before = await authGet(
      `/api/device-link?token=${token}`,
      initiator.publicKey,
      initiator.secretKey
    );
    expect(before.status).toBe(200);
    expect(before.data.ephemeralPublicKey).toBeNull();

    const ephemeral = ephemeralKeys();
    const claim = await post("/api/device-link/claim", {
      token,
      ephemeralPublicKey: ephemeral.publicKey,
    });
    expect(claim.status).toBe(200);

    const after = await authGet(
      `/api/device-link?token=${token}`,
      initiator.publicKey,
      initiator.secretKey
    );
    expect(after.data.ephemeralPublicKey).toBe(ephemeral.publicKey);

    const sealed = sodium.crypto_box_seal(
      sodium.from_string(JSON.stringify({ v: 1, secret: "identity" })),
      ephemeral.raw.publicKey
    );
    const put = await authPost(
      "/api/device-link/payload",
      { token, payload: b64(sealed) },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(put.status).toBe(200);

    // The new device has no identity yet, so collecting is unauthenticated.
    const collected = await anonGet(`/api/device-link/payload?token=${token}`);
    expect(collected.status).toBe(200);

    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(collected.data.payload, sodium.base64_variants.ORIGINAL),
      ephemeral.raw.publicKey,
      ephemeral.raw.privateKey
    );
    expect(JSON.parse(sodium.to_string(opened)).secret).toBe("identity");
  });

  test("the bundle is handed over once and then forgotten", async () => {
    const { initiator } = await createPair();
    const token = await openMailbox(initiator);
    const ephemeral = ephemeralKeys();

    await post("/api/device-link/claim", { token, ephemeralPublicKey: ephemeral.publicKey });
    await authPost(
      "/api/device-link/payload",
      {
        token,
        payload: b64(sodium.crypto_box_seal(sodium.from_string("x"), ephemeral.raw.publicKey)),
      },
      initiator.publicKey,
      initiator.secretKey
    );

    expect((await anonGet(`/api/device-link/payload?token=${token}`)).status).toBe(200);
    expect((await anonGet(`/api/device-link/payload?token=${token}`)).status).toBe(404);
  });

  test("a second device cannot swap in its own key mid-handshake", async () => {
    const { initiator } = await createPair();
    const token = await openMailbox(initiator);

    const first = ephemeralKeys();
    const second = ephemeralKeys();

    expect(
      (await post("/api/device-link/claim", { token, ephemeralPublicKey: first.publicKey })).status
    ).toBe(200);
    expect(
      (await post("/api/device-link/claim", { token, ephemeralPublicKey: second.publicKey })).status
    ).toBe(409);

    // Re-sending the same key is a harmless retry, not a hijack.
    expect(
      (await post("/api/device-link/claim", { token, ephemeralPublicKey: first.publicKey })).status
    ).toBe(200);
  });

  test("only the device that started the transfer can read or fill it", async () => {
    const { initiator } = await createPair();
    const stranger = (await createPair()).initiator;
    const token = await openMailbox(initiator);
    await post("/api/device-link/claim", { token, ephemeralPublicKey: ephemeralKeys().publicKey });

    const peek = await authGet(`/api/device-link?token=${token}`, stranger.publicKey, stranger.secretKey);
    expect(peek.status).toBe(403);

    const push = await authPost(
      "/api/device-link/payload",
      { token, payload: "AAAA" },
      stranger.publicKey,
      stranger.secretKey
    );
    expect(push.status).toBe(403);
  });

  test("payload is refused before the other device has joined", async () => {
    const { initiator } = await createPair();
    const token = await openMailbox(initiator);

    const early = await authPost(
      "/api/device-link/payload",
      { token, payload: "AAAA" },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(early.status).toBe(409);
  });

  test("an unknown token is rejected", async () => {
    const claim = await post("/api/device-link/claim", {
      token: "not-a-real-token",
      ephemeralPublicKey: ephemeralKeys().publicKey,
    });
    expect(claim.status).toBe(404);
    expect((await anonGet("/api/device-link/payload?token=not-a-real-token")).status).toBe(404);
  });

  test("starting a transfer requires a signature", async () => {
    expect((await post("/api/device-link/start", {})).status).toBe(401);
  });

  test("rejects a malformed ephemeral key", async () => {
    const { initiator } = await createPair();
    const token = await openMailbox(initiator);

    const claim = await post("/api/device-link/claim", {
      token,
      ephemeralPublicKey: b64(new Uint8Array(16)),
    });
    expect(claim.status).toBe(400);
  });
});
