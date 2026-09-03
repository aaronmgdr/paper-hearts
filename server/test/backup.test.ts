import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import sodium from "libsodium-wrappers-sumo";
import { startServer, stopServer } from "./setup";
import { authPut, authGet, authDelete, anonGet, createPair } from "./helpers";

beforeAll(async () => {
  await startServer();
  await sodium.ready;
});

afterAll(async () => {
  await stopServer();
});

/** Stand-in for a client-derived locator: 32 bytes, URL-safe base64. */
function locator() {
  return sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.URLSAFE_NO_PADDING);
}

const payload = (s: string) => Buffer.from(s).toString("base64");

describe("recovery backup", () => {
  test("restores with the locator alone — no key left to sign with", async () => {
    // The whole point: after losing every phone there is no identity to
    // authenticate as, so reading a backup must need nothing but the code.
    const { initiator } = await createPair();
    const loc = locator();

    const put = await authPut(
      "/api/backup",
      { locator: loc, payload: payload("ciphertext") },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(put.status).toBe(200);

    const got = await anonGet(`/api/backup?locator=${encodeURIComponent(loc)}`);
    expect(got.status).toBe(200);
    expect(Buffer.from(got.data.payload, "base64").toString()).toBe("ciphertext");
  });

  test("an unknown locator finds nothing", async () => {
    expect((await anonGet(`/api/backup?locator=${locator()}`)).status).toBe(404);
  });

  test("uploading requires a signature", async () => {
    const { handleApi } = await import("../app");
    const req = new Request("http://localhost/api/backup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locator: locator(), payload: payload("x") }),
    });
    expect((await handleApi(req, "/api/backup")).status).toBe(401);
  });

  test("a new recovery code retires the old backup", async () => {
    // Otherwise a code the user believes they replaced would still open a copy
    // of their diary.
    const { initiator } = await createPair();
    const first = locator();
    const second = locator();

    await authPut("/api/backup", { locator: first, payload: payload("old") }, initiator.publicKey, initiator.secretKey);
    await authPut("/api/backup", { locator: second, payload: payload("new") }, initiator.publicKey, initiator.secretKey);

    expect((await anonGet(`/api/backup?locator=${first}`)).status).toBe(404);
    const current = await anonGet(`/api/backup?locator=${second}`);
    expect(Buffer.from(current.data.payload, "base64").toString()).toBe("new");
  });

  test("re-uploading under the same locator replaces the contents", async () => {
    const { initiator } = await createPair();
    const loc = locator();

    await authPut("/api/backup", { locator: loc, payload: payload("day one") }, initiator.publicKey, initiator.secretKey);
    await authPut("/api/backup", { locator: loc, payload: payload("day two") }, initiator.publicKey, initiator.secretKey);

    const got = await anonGet(`/api/backup?locator=${loc}`);
    expect(Buffer.from(got.data.payload, "base64").toString()).toBe("day two");
  });

  test("status and deletion are scoped to the account", async () => {
    const { initiator } = await createPair();
    const other = (await createPair()).initiator;
    const loc = locator();

    await authPut("/api/backup", { locator: loc, payload: payload("mine") }, initiator.publicKey, initiator.secretKey);

    const mine = await authGet("/api/backup/status", initiator.publicKey, initiator.secretKey);
    expect(mine.data.exists).toBe(true);
    expect(mine.data.bytes).toBe(Buffer.from("mine").length);

    const theirs = await authGet("/api/backup/status", other.publicKey, other.secretKey);
    expect(theirs.data.exists).toBe(false);

    // Someone else's delete must not touch it.
    await authDelete("/api/backup", other.publicKey, other.secretKey);
    expect((await anonGet(`/api/backup?locator=${loc}`)).status).toBe(200);

    await authDelete("/api/backup", initiator.publicKey, initiator.secretKey);
    expect((await anonGet(`/api/backup?locator=${loc}`)).status).toBe(404);
  });

  test("rejects a locator too short to be a real one", async () => {
    const { initiator } = await createPair();
    const short = await authPut(
      "/api/backup",
      { locator: "abc", payload: payload("x") },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(short.status).toBe(400);
    expect((await anonGet("/api/backup?locator=abc")).status).toBe(400);
  });
});
