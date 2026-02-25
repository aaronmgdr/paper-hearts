import { mock, describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { startServer, stopServer } from "./setup";

// Mock web-push BEFORE any module that imports it is loaded.
// Each test file runs in its own module context in bun:test, so this mock
// is isolated to this file and does not affect pairs.test.ts or entries.test.ts.
const mockSendNotification = mock(async (_sub: unknown, _payload: unknown) => ({
  statusCode: 201,
  headers: {},
  body: "",
}));

mock.module("web-push", () => ({
  default: {
    setVapidDetails: mock(() => {}),
    sendNotification: mockSendNotification,
  },
}));

// Dynamic imports AFTER mock is registered so web-push is mocked when first loaded.
// Static imports (above) are hoisted before any module code runs, so helpers
// must be imported dynamically here to ensure mock.module takes effect first.
const { createPair, todayDayId, post, authPost } = await import("./helpers");

beforeAll(startServer);
afterAll(stopServer);

const fakeSub = {
  endpoint: "https://fcm.googleapis.com/fcm/send/fake-endpoint",
  keys: { p256dh: "BFakeP256DHKey", auth: "fakeAuth" },
};

describe("POST /api/push/subscribe", () => {
  test("registers a push subscription", async () => {
    const { initiator } = await createPair();

    const { status, data } = await authPost(
      "/api/push/subscribe",
      fakeSub,
      initiator.publicKey,
      initiator.secretKey
    );

    expect(status).toBe(200);
    expect(data.status).toBe("subscribed");
  });

  test("updates an existing subscription", async () => {
    const { initiator } = await createPair();

    await authPost("/api/push/subscribe", fakeSub, initiator.publicKey, initiator.secretKey);

    const updated = { ...fakeSub, endpoint: "https://fcm.googleapis.com/fcm/send/updated" };
    const { status, data } = await authPost(
      "/api/push/subscribe",
      updated,
      initiator.publicKey,
      initiator.secretKey
    );

    expect(status).toBe(200);
    expect(data.status).toBe("subscribed");
  });

  test("rejects missing endpoint", async () => {
    const { initiator } = await createPair();
    const { status } = await authPost(
      "/api/push/subscribe",
      { keys: fakeSub.keys },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(status).toBe(400);
  });

  test("rejects missing keys", async () => {
    const { initiator } = await createPair();
    const { status } = await authPost(
      "/api/push/subscribe",
      { endpoint: fakeSub.endpoint },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(status).toBe(400);
  });

  test("rejects unauthenticated request", async () => {
    const { status } = await post("/api/push/subscribe", fakeSub);
    expect(status).toBe(401);
  });
});

describe("notification trigger on entry write", () => {
  test("calls sendNotification when partner has a subscription", async () => {
    const consoleErrorSpy = spyOn(console, "error");
    const { initiator, follower } = await createPair();

    // Register push subscription for the follower (they'll receive the notification)
    await authPost("/api/push/subscribe", fakeSub, follower.publicKey, follower.secretKey);

    mockSendNotification.mockClear();

    // Initiator writes an entry
    const { status } = await authPost(
      "/api/entries",
      { dayId: todayDayId(), payload: Buffer.from("hello partner").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(status).toBe(201);

    // notifyPartner is fire-and-forget — poll until called or deadline
    const deadline = Date.now() + 15000;
    while (mockSendNotification.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const [sub, payload] = mockSendNotification.mock.calls[0];
    expect((sub as any).endpoint).toBe(fakeSub.endpoint);
    expect((sub as any).keys.p256dh).toBe(fakeSub.keys.p256dh);
    expect(JSON.parse(payload as string)).toMatchObject({ type: "partner-entry" });
  });

  test("does not call sendNotification when partner has no subscription", async () => {
    const { initiator } = await createPair();

    mockSendNotification.mockClear();

    const { status } = await authPost(
      "/api/entries",
      { dayId: todayDayId(), payload: Buffer.from("hello").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );
    expect(status).toBe(201);

    await new Promise((r) => setTimeout(r, 200));

    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});

describe("push subscription survives re-pairing", () => {
  test("initiator can re-subscribe after re-pairing", async () => {
    const { initiator, follower } = await createPair();

    await authPost("/api/push/subscribe", fakeSub, initiator.publicKey, initiator.secretKey);

    const reInitRes = await post("/api/pairs/initiate", { publicKey: initiator.publicKey });
    expect(reInitRes.status).toBe(201);

    await post("/api/pairs/join", {
      publicKey: follower.publicKey,
      relayToken: reInitRes.data.relayToken,
    });

    const sub2 = await authPost(
      "/api/push/subscribe",
      fakeSub,
      initiator.publicKey,
      initiator.secretKey
    );
    expect(sub2.status).toBe(200);
  });

  test("notification goes to new subscription after re-pairing", async () => {
    const { initiator, follower } = await createPair();

    // Follower registers subscription, then re-pairs
    await authPost("/api/push/subscribe", fakeSub, follower.publicKey, follower.secretKey);

    const reInitRes = await post("/api/pairs/initiate", { publicKey: initiator.publicKey });
    await post("/api/pairs/join", {
      publicKey: follower.publicKey,
      relayToken: reInitRes.data.relayToken,
    });

    // Re-register with a new endpoint after re-pair
    const newSub = { ...fakeSub, endpoint: "https://fcm.googleapis.com/fcm/send/new-sub" };
    await authPost("/api/push/subscribe", newSub, follower.publicKey, follower.secretKey);

    mockSendNotification.mockClear();

    await authPost(
      "/api/entries",
      { dayId: todayDayId(), payload: Buffer.from("new pair entry").toString("base64") },
      initiator.publicKey,
      initiator.secretKey
    );

    // notifyPartner is fire-and-forget — poll until called or 3s deadline
    const deadline = Date.now() + 3000;
    while (mockSendNotification.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const [sub] = mockSendNotification.mock.calls[0];
    expect((sub as any).endpoint).toBe(newSub.endpoint);
  });
});
